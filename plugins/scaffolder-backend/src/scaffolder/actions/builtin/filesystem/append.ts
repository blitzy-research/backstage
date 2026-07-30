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
import { InputError } from '@backstage/errors';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import fs from 'fs-extra';
import { examples } from './append.examples';

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

      for (const file of ctx.input.files) {
        // The content is checked with a typeof test rather than for truthiness so
        // that appending a legitimate empty string is not rejected.
        if (!file.path || typeof file.content !== 'string') {
          throw new InputError(
            'each file must have a path and content property',
          );
        }

        // Resolved before the try block below, so the NotAllowedError raised for a
        // path that points outside of the workspace always propagates untouched,
        // and is never downgraded or suppressed by the dry run handling.
        const filepath = resolveSafeChildPath(ctx.workspacePath, file.path);

        // The fallback is applied here rather than in the schema above, because the
        // returned handler is not wrapped in schema validation. The schema is only
        // converted to a JSON Schema for the UI, so a schema level fallback would
        // not be applied when the handler is invoked directly.
        const createIfMissing = file.createIfMissing ?? true;

        try {
          if (await fs.pathExists(filepath)) {
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
            throw new InputError(
              `Cannot append to file ${filepath} because it does not exist and createIfMissing is false`,
            );
          }

          ctx.logger.info(`Content appended to file ${filepath} successfully`);
        } catch (err) {
          ctx.logger.error(
            `Failed to append content to file ${filepath}:`,
            err,
          );
          throw err;
        }
      }
    },
  });
};
