/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { InputError, isError, NotAllowedError } from '@backstage/errors';
import {
  LoggerService,
  resolveSafeChildPath,
} from '@backstage/backend-plugin-api';
import { isAbsolute } from 'node:path';
import fs from 'fs-extra';
import { examples } from './append.examples';

// Resolves to false only for a genuinely absent target, rethrowing every other
// failure with its cause. fs.pathExists is not used: it suppresses every access
// error, which would misreport a real failure as a missing target.
const pathExistsOrThrow = async (filepath: string): Promise<boolean> => {
  try {
    await fs.access(filepath);
    return true;
  } catch (err) {
    if (isError(err) && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
};

// An errno such as ENOTDIR or EACCES is the single most useful part of a native
// filesystem failure, and unlike the rest of the failure it is never caller
// derived. Only a value matching this shape is carried into a message, which
// keeps the allow list narrow enough that no control character, path fragment or
// other unexpected text can reach a log record or an escaping error through it.
const asErrnoCode = (err: unknown): string | undefined => {
  if (!isError(err) || typeof err.code !== 'string') {
    return undefined;
  }
  return /^[A-Z][A-Z0-9_]*$/.test(err.code) ? err.code : undefined;
};

// Builds the failure that leaves the handler, and the single message that is
// logged for it, out of nothing but the entry's index in the files input and an
// allow listed errno.
//
// Neither the caller supplied path nor the path it resolves to is ever included.
// A path is step input rendered with task and environment secrets in scope, and
// a valid POSIX filename may contain carriage returns, line feeds or terminal
// escape sequences, so repeating one would risk forging log records and
// disclosing secrets or the layout of the workspace. An escaping error is
// audited from its own fields, its stack and its cause chain, none of which pass
// the secret redaction that ctx.logger output does. The entry's index is enough
// to identify it, because the caller authored the files input it indexes.
const withoutPathDetail = (err: unknown, index: number): Error => {
  // Raised below with a deliberately path free message, so it already carries
  // nothing caller derived and is returned as it is. That also keeps the
  // documented InputError contract for a file that an author required to exist.
  if (err instanceof InputError) {
    return err;
  }

  const code = asErrnoCode(err);

  // The original error is deliberately neither attached as a cause nor handed to
  // the logger. A native filesystem failure repeats the resolved path in its own
  // message and in enumerable fields such as path and dest, and error
  // serialization follows the cause chain, so either would put back exactly what
  // the replacement message leaves out.
  return new Error(
    `Failed to append content to the file at index ${index} of the files input${
      code ? ` (${code})` : ''
    }`,
  );
};

// Reports a failure through the step logger and returns the error to throw for
// it. Both carry exactly the same path free text, so the log record cannot
// disclose a detail that the escaping error withholds, or the other way around.
const logFailure = (
  logger: LoggerService,
  err: unknown,
  index: number,
): Error => {
  const failure = withoutPathDetail(err, index);
  logger.error(failure.message);
  return failure;
};

/**
 * Creates a new action that enables appending content to files in the workspace.
 * @public
 */
export const createFilesystemAppendAction = () => {
  return createTemplateAction({
    id: 'fs:append',
    description: 'Appends content to files in the workspace',
    examples,
    schema: {
      input: {
        files: z =>
          z
            .array(
              z.object({
                path: z.string({
                  description:
                    'The workspace-relative path of the file to append to',
                }),
                content: z.string({
                  description: 'The content that will be appended to the file',
                }),
                createIfMissing: z
                  .boolean({
                    description:
                      'Create the file (and any missing parent directories) if it does not exist, default is true',
                  })
                  .optional(),
              }),
              { description: 'A list of files that will be appended to' },
            )
            .nonempty(),
      },
    },
    supportsDryRun: true,
    async handler(ctx) {
      if (!Array.isArray(ctx.input?.files)) {
        throw new InputError('files must be an Array');
      }

      // The index is carried alongside each entry so that a failure can name the
      // entry it belongs to without naming its path, which is caller derived.
      for (const [index, file] of ctx.input.files.entries()) {
        // Type checks rather than truthiness, so a malformed entry raises an
        // InputError, not a downstream TypeError, and empty content is valid.
        if (
          typeof file?.path !== 'string' ||
          file.path.length === 0 ||
          typeof file.content !== 'string'
        ) {
          throw new InputError(
            'each file must have a path and content property',
          );
        }

        // The documented input contract is a workspace-relative path, and this is
        // where that contract is enforced. resolveSafeChildPath on its own does
        // not enforce it: it accepts an absolute path whenever the path happens
        // to resolve inside the workspace, which would both widen the accepted
        // input beyond what the schema declares and couple templates to the
        // internal layout of the per-run workspace directory. The check runs
        // before the resolution below so that no absolute path reaches the
        // filesystem, and its message names the entry by its index rather than by
        // its path, which is caller derived.
        if (isAbsolute(file.path)) {
          throw new InputError(
            `the path of the file at index ${index} of the files input must be workspace-relative`,
          );
        }

        // Resolved before the try block below, so the NotAllowedError raised for a
        // path that points outside of the workspace always propagates untouched,
        // and is never downgraded or suppressed by the dry run handling. Its
        // message names no path; any other failure raised there is stripped
        // like every other escaping error.
        let filepath: string;
        try {
          filepath = resolveSafeChildPath(ctx.workspacePath, file.path);
        } catch (err) {
          if (err instanceof NotAllowedError) {
            throw err;
          }
          throw logFailure(ctx.logger, err, index);
        }

        // The fallback is applied here rather than in the schema above, because the
        // returned handler is not wrapped in schema validation. The schema is only
        // converted to a JSON Schema for the UI, so a schema level fallback would
        // not be applied when the handler is invoked directly.
        const createIfMissing = file.createIfMissing ?? true;

        try {
          if (await pathExistsOrThrow(filepath)) {
            await fs.appendFile(filepath, file.content);
          } else if (createIfMissing) {
            // Writes the content as the entire body of the new file and creates any
            // missing parent directories along the way, which appendFile on its own
            // does not do.
            await fs.outputFile(filepath, file.content);
          } else if (ctx.isDryRun) {
            // A dry run must not fail purely because a target does not exist yet, so
            // this entry is skipped and the remaining ones are still processed.
            ctx.logger.warn(
              `Skipped the file at index ${index} of the files input during a dry run, it does not exist and createIfMissing is false`,
            );
            continue;
          } else {
            // Named by its index like every other message this action emits: this
            // error escapes the handler, and the path is caller derived.
            throw new InputError(
              `Cannot append to the file at index ${index} of the files input because it does not exist and createIfMissing is false`,
            );
          }

          ctx.logger.info(
            `Content appended to the file at index ${index} of the files input successfully`,
          );
        } catch (err) {
          throw logFailure(ctx.logger, err, index);
        }
      }
    },
  });
};
