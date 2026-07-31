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
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
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

// Strips caller derived path information out of an error before it leaves the
// handler, naming the offending entry by its index in the files input instead.
// Paths are step input rendered with task and environment secrets in scope, and
// an escaping error is audited from its own fields, its stack and its cause
// chain, none of which pass the secret redaction that ctx.logger output does.
const withoutPathDetail = (err: unknown, index: number): Error => {
  // Raised below with a deliberately path free message, so it already carries
  // nothing caller derived and is returned as it is. That also keeps the
  // documented InputError contract for a file that an author required to exist.
  if (err instanceof InputError) {
    return err;
  }

  // A filesystem error code such as ENOTDIR or EACCES is the single most useful
  // part of a native failure and is never caller derived, so it is the one
  // detail that is carried over into the replacement message.
  const code =
    isError(err) && typeof err.code === 'string' ? ` (${err.code})` : '';

  // The original error is deliberately not attached as a cause. A native
  // filesystem failure repeats the resolved path in its own message and in
  // enumerable fields such as path and dest, and error serialization follows the
  // cause chain, so a raw cause would put back exactly what the replacement
  // message leaves out. The untouched error is reported through ctx.logger at
  // each throw site instead, where secret redaction runs first.
  return new Error(
    `Failed to append content to the file at index ${index} of the files input${code}, see the step log for the resolved path`,
  );
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
          ctx.logger.error(
            `Failed to resolve the path of file ${file.path}:`,
            err,
          );
          throw withoutPathDetail(err, index);
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
              `Skipped appending to file ${filepath} during a dry run, the file does not exist and createIfMissing is false`,
            );
            continue;
          } else {
            // The resolved path is deliberately left out of this message because
            // the error escapes the handler, see withoutPathDetail above. The
            // catch below reports the path through ctx.logger instead.
            throw new InputError(
              `Cannot append to the file at index ${index} of the files input because it does not exist and createIfMissing is false`,
            );
          }

          ctx.logger.info(`Content appended to file ${filepath} successfully`);
        } catch (err) {
          // On failure the resolved path is reported through ctx.logger, whose
          // secret redaction runs before anything is persisted; the rethrown
          // error is stripped of it.
          ctx.logger.error(
            `Failed to append content to file ${filepath}:`,
            err,
          );
          throw withoutPathDetail(err, index);
        }
      }
    },
  });
};
