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

import { dirname, resolve as resolvePath } from 'node:path';
import { createFilesystemAppendAction } from './append';
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import fs from 'fs-extra';
import yaml from 'yaml';
import { examples } from './append.examples';
import { createMockDirectory } from '@backstage/backend-test-utils';

type AppendFile = {
  path: string;
  content: string;
  createIfMissing?: boolean;
};

// The shape of a complete published step, so that each example is parsed in full
// rather than reaching straight for its input. `.nonempty()` infers a non-empty
// tuple, so annotate the parsed YAML to keep handler inputs type-safe.
type AppendStep = {
  action: string;
  id: string;
  name: string;
  input: { files: [AppendFile, ...AppendFile[]] };
};

describe('fs:append examples', () => {
  const action = createFilesystemAppendAction();

  // Every example is parsed as a whole step, so a snippet that names another
  // action or nests its input differently is caught by the assertions in each
  // case below instead of quietly documenting behaviour that is never executed.
  const appendToExistingStep: AppendStep = yaml.parse(examples[0].example)
    .steps[0];
  const createMissingStep: AppendStep = yaml.parse(examples[1].example)
    .steps[0];
  const strictAppendStep: AppendStep = yaml.parse(examples[2].example).steps[0];

  // The handler is driven with the input of the parsed step, never with a
  // hand-written copy of it.
  const appendToExisting = appendToExistingStep.input.files;
  const createMissing = createMissingStep.input.files;
  const strictAppend = strictAppendStep.input.files;

  const mockDir = createMockDirectory();
  const workspacePath = resolvePath(mockDir.path, 'workspace');

  const mockContext = createMockActionContext({
    input: {
      files: appendToExisting,
    },
    workspacePath,
  });

  beforeEach(() => {
    jest.restoreAllMocks();

    mockDir.setContent({
      [workspacePath]: {
        [appendToExisting[0].path]: 'hello',
        [appendToExisting[1].path]: 'world',
      },
    });
  });

  it('should append content to files that already exist', async () => {
    // The examples only reach template authors once the factory publishes them,
    // and the count is pinned here so a fourth example cannot ship without a
    // case of its own in this suite.
    expect(action.examples).toEqual(examples);
    expect(action.examples).toHaveLength(3);

    expect(appendToExistingStep.action).toEqual('fs:append');

    // Keep the batch aligned with the two seeded files so this case cannot fall
    // through to create-if-missing.
    expect(appendToExisting).toHaveLength(2);

    const contentBefore = await Promise.all(
      appendToExisting.map(file =>
        fs.readFile(resolvePath(workspacePath, file.path), 'utf-8'),
      ),
    );

    expect(contentBefore).toEqual(['hello', 'world']);

    await action.handler({
      ...mockContext,
      input: {
        files: appendToExisting,
      },
    });

    for (const [index, file] of appendToExisting.entries()) {
      expect(
        await fs.readFile(resolvePath(workspacePath, file.path), 'utf-8'),
      ).toEqual(`${contentBefore[index]}${file.content}`);
    }
  });

  it('should create the file and its parent directories when it does not exist', async () => {
    expect(createMissingStep.action).toEqual('fs:append');
    expect(createMissing[0].createIfMissing).toBe(true);

    const target = resolvePath(workspacePath, createMissing[0].path);
    const parentDirectory = resolvePath(
      workspacePath,
      dirname(createMissing[0].path),
    );

    // Require a nested target so this example continues to exercise
    // parent-directory creation.
    expect(parentDirectory).not.toEqual(workspacePath);
    expect(fs.existsSync(parentDirectory)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);

    await action.handler({
      ...mockContext,
      input: {
        files: createMissing,
      },
    });

    expect(fs.existsSync(parentDirectory)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);

    expect(await fs.readFile(target, 'utf-8')).toEqual(
      createMissing[0].content,
    );
  });

  it('should append only to a file that already exists', async () => {
    expect(strictAppendStep.action).toEqual('fs:append');
    expect(strictAppend[0].createIfMissing).toBe(false);
    expect(strictAppend[0].path).toEqual(appendToExisting[0].path);

    const target = resolvePath(workspacePath, strictAppend[0].path);

    expect(fs.existsSync(target)).toBe(true);

    const contentBefore = await fs.readFile(target, 'utf-8');

    await action.handler({
      ...mockContext,
      input: {
        files: strictAppend,
      },
    });

    expect(await fs.readFile(target, 'utf-8')).toEqual(
      `${contentBefore}${strictAppend[0].content}`,
    );
  });
});
