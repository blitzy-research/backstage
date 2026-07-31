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

/**
 * The shape of a single entry of the action's `files` input.
 *
 * It is declared locally because the action derives its input type from its zod
 * schema and therefore exports no named type for an individual entry.
 */
type AppendFile = {
  path: string;
  content: string;
  createIfMissing?: boolean;
};

describe('fs:append examples', () => {
  const action = createFilesystemAppendAction();

  // Every input below is hoisted out of the documented YAML instead of being
  // written out by hand, which is what makes this suite a guard against the
  // published documentation drifting away from the behaviour it describes: the
  // real handler is driven with exactly the bytes a template author would copy
  // out of the action browser.
  //
  // The input schema chains `.nonempty()`, so the handler's input type is the
  // non-empty tuple `[AppendFile, ...AppendFile[]]` rather than a plain array.
  // Parsing the documented YAML yields `any`, so annotating each hoisted value
  // as that tuple keeps every handler call assignable without a cast.
  const appendToExisting: [AppendFile, ...AppendFile[]] = yaml.parse(
    examples[0].example,
  ).steps[0].input.files;
  const createMissing: [AppendFile, ...AppendFile[]] = yaml.parse(
    examples[1].example,
  ).steps[0].input.files;
  const strictAppend: [AppendFile, ...AppendFile[]] = yaml.parse(
    examples[2].example,
  ).steps[0].input.files;

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

    // Seeded from the parsed example so that the fixture cannot fall out of step
    // with the documentation. Only the two files of the batch example are
    // created: the create-if-missing example documents a path that has to stay
    // absent for its own case to mean anything, and the strict example documents
    // the same path as the first entry here, so it is already covered.
    mockDir.setContent({
      [workspacePath]: {
        [appendToExisting[0].path]: 'hello',
        [appendToExisting[1].path]: 'world',
      },
    });
  });

  it('should append content to files that already exist', async () => {
    // Pins the batch example to the seed above. Without this, a new entry added
    // to the example would be appended to a file this suite never seeded, which
    // would quietly exercise the create-if-missing branch instead of the append
    // branch this case is here to prove.
    expect(appendToExisting).toHaveLength(2);

    // Captured before the handler runs so that the assertions below prove the
    // original bytes survived, rather than merely that the appended bytes are
    // present somewhere in the file.
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

    // Every documented entry is verified, which is what demonstrates that the
    // multi-file batch form of the example genuinely works.
    for (const [index, file] of appendToExisting.entries()) {
      expect(
        await fs.readFile(resolvePath(workspacePath, file.path), 'utf-8'),
      ).toEqual(`${contentBefore[index]}${file.content}`);
    }
  });

  it('should create the file and its parent directories when it does not exist', async () => {
    // This example documents the default explicitly, which is the entire reason
    // it exists, so the flag is asserted rather than assumed.
    expect(createMissing[0].createIfMissing).toBe(true);

    const target = resolvePath(workspacePath, createMissing[0].path);
    const parentDirectory = resolvePath(
      workspacePath,
      dirname(createMissing[0].path),
    );

    // The documented path is nested, so its parent is absent from the seed as
    // well. Asserting that keeps this case honest: were the example ever
    // flattened to a top-level path, this would fail loudly instead of quietly
    // stopping to prove that missing parents get created.
    expect(parentDirectory).not.toEqual(workspacePath);
    expect(fs.existsSync(parentDirectory)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);

    await action.handler({
      ...mockContext,
      input: {
        files: createMissing,
      },
    });

    // The created parent directory is what proves `fs.outputFile` ran rather
    // than `fs.appendFile`, which cannot create missing parents.
    expect(fs.existsSync(parentDirectory)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);

    // Exactly the documented content and nothing else, because the file was
    // created rather than appended to.
    expect(await fs.readFile(target, 'utf-8')).toEqual(
      createMissing[0].content,
    );
  });

  it('should append only to a file that already exists', async () => {
    // Strict mode is the point of this example, and it only holds while the
    // documented path is one that the seed creates.
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

    // `createIfMissing: false` is perfectly happy when the target does exist:
    // the original bytes are preserved and the documented content lands at the
    // end of the file.
    expect(await fs.readFile(target, 'utf-8')).toEqual(
      `${contentBefore}${strictAppend[0].content}`,
    );
  });
});
