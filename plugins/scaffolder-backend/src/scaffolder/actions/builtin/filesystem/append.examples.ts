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

import { TemplateExample } from '@backstage/plugin-scaffolder-node';
import * as yaml from 'yaml';

export const examples: TemplateExample[] = [
  {
    description: 'Append content to files that already exist',
    example: yaml.stringify({
      steps: [
        {
          action: 'fs:append',
          id: 'appendFiles',
          name: 'Append files',
          input: {
            files: [
              { path: 'file1.txt', content: 'Appended content for file1\n' },
              { path: 'file2.txt', content: 'Appended content for file2\n' },
            ],
          },
        },
      ],
    }),
  },
  {
    description: 'Append content to a file, creating it if it does not exist',
    example: yaml.stringify({
      steps: [
        {
          action: 'fs:append',
          id: 'appendFiles',
          name: 'Append files',
          input: {
            files: [
              {
                path: 'docs/changelog.md',
                content: '- initial entry\n',
                createIfMissing: true,
              },
            ],
          },
        },
      ],
    }),
  },
  {
    description: 'Append only to a file that must already exist',
    example: yaml.stringify({
      steps: [
        {
          action: 'fs:append',
          id: 'appendFiles',
          name: 'Append files',
          input: {
            files: [
              {
                path: 'file1.txt',
                content: 'Strict appended content\n',
                createIfMissing: false,
              },
            ],
          },
        },
      ],
    }),
  },
];
