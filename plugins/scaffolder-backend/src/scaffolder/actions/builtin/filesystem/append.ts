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

/**
 * Checks whether the target already exists, resolving to false only when it is
 * genuinely absent and rethrowing every other failure with its original cause.
 *
 * fs.pathExists is deliberately not used here. It is an access check whose
 * rejection is swallowed, so it reports every failure as a missing target,
 * including a real one such as a parent directory that cannot be read or a
 * parent path segment that is a file rather than a directory. That would let a
 * genuine filesystem error be skipped by the dry run branch below, or be
 * reported as a file that does not exist yet, instead of being logged in full
 * and rethrown.
 */
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

/**
 * Strips caller derived path information out of an error before it leaves the
 * handler, identifying the offending entry by its position in the files input
 * instead.
 *
 * A path is step input, and step input is rendered with the task and the
 * configured environment secrets in scope, so a rendered secret can end up
 * inside a path. The two channels that carry a failure out of an action redact
 * very differently: anything written through ctx.logger passes the step
 * logger's secret redaction before it is persisted, whereas an error that
 * escapes the handler is persisted to the task event stream from its raw stack,
 * which never reaches that redaction. No error may therefore carry a path out
 * of this handler. The resolved path is reported through ctx.logger instead,
 * and the error that caused the failure is kept as the cause, so that neither
 * the path nor the original errno is lost to whoever has to diagnose the task.
 */
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

  return new Error(
    `Failed to append content to the file at index ${index} of the files input${code}, see the step log for the resolved path`,
    { cause: err },
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
        // Both properties are validated with typeof tests rather than for
        // truthiness, so that every malformed entry - a null or undefined element,
        // or a path or content that is not a string - is reported as an InputError
        // instead of surfacing later as a native TypeError, while appending a
        // legitimate empty string is still accepted.
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
        // and is never downgraded or suppressed by the dry run handling.
        //
        // The helper resolves the real path of the target to do that check, so it
        // can also surface a native failure - an ENOTDIR when a parent segment is
        // a file rather than a directory, for instance. That one quotes the path
        // it failed on, so it is stripped like every other escaping error, while
        // the NotAllowedError, whose message names no path, is re-raised exactly
        // as it was thrown.
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
            // Appending preserves every byte that is already in the file.
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
          // ctx.logger is the step logger, whose secret redaction runs before
          // anything is persisted, so this is the only place the resolved path is
          // reported. The rethrown error is stripped of it.
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
