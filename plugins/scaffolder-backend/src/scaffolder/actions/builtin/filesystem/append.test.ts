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

import { resolve as resolvePath } from 'node:path';
import { createFilesystemAppendAction } from './append';
import { createFilesystemAppendAction as createFromBarrel } from './index';
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { InputError } from '@backstage/errors';
import fs from 'fs-extra';
import { createMockDirectory } from '@backstage/backend-test-utils';

type AppendFile = {
  path: string;
  content: string;
  createIfMissing?: boolean;
};

describe('fs:append', () => {
  const action = createFilesystemAppendAction();

  const mockDir = createMockDirectory();
  const workspacePath = resolvePath(mockDir.path, 'workspace');

  // `.nonempty()` infers a non-empty tuple, so keep the shared mock input
  // tuple-typed.
  const mockInputFiles: [AppendFile, ...AppendFile[]] = [
    {
      path: 'unit-test-a.js',
      content: ' appended',
    },
  ];
  const mockContext = createMockActionContext({
    input: {
      files: mockInputFiles,
    },
    workspacePath,
  });

  beforeEach(() => {
    jest.restoreAllMocks();

    mockDir.setContent({
      [workspacePath]: {
        'unit-test-a.js': 'hello',
        'unit-test-b.js': 'world',
        'a-folder': {
          'file.md': 'content',
        },
      },
    });
  });

  it('should have the correct action id', () => {
    expect(action.id).toEqual('fs:append');
  });

  it('should be exported from the filesystem actions barrel', () => {
    expect(createFromBarrel().id).toEqual('fs:append');
  });

  it('should append content to an existing file preserving the original content', async () => {
    const filePath = resolvePath(workspacePath, 'unit-test-a.js');
    const beforeContent = await fs.readFile(filePath, 'utf-8');

    expect(beforeContent).toEqual('hello');

    await action.handler({
      ...mockContext,
      input: { files: [{ path: 'unit-test-a.js', content: ' appended' }] },
    });

    const afterContent = await fs.readFile(filePath, 'utf-8');

    expect(afterContent).toEqual(`${beforeContent} appended`);
  });

  it('should create the file and any missing parent directories when it does not exist', async () => {
    const target = resolvePath(workspacePath, 'new-folder/nested/created.txt');
    const parentDirectory = resolvePath(workspacePath, 'new-folder/nested');

    expect(fs.existsSync(parentDirectory)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);

    // `createIfMissing` is deliberately omitted so that this case exercises the
    // handler's own fallback. A schema level default would not be applied here,
    // because the returned handler is not wrapped in schema validation.
    await action.handler({
      ...mockContext,
      input: {
        files: [{ path: 'new-folder/nested/created.txt', content: 'created' }],
      },
    });

    expect(fs.existsSync(parentDirectory)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    expect(await fs.readFile(target, 'utf-8')).toEqual('created');
  });

  it('should throw when the file does not exist and createIfMissing is false', async () => {
    const target = resolvePath(workspacePath, 'does-not-exist.txt');

    expect(fs.existsSync(target)).toBe(false);

    const rejected = action.handler({
      ...mockContext,
      input: {
        files: [
          {
            path: 'does-not-exist.txt',
            content: 'x',
            createIfMissing: false,
          },
        ],
      },
    });

    await expect(rejected).rejects.toThrow(InputError);
    await expect(rejected).rejects.toThrow(
      /does not exist and createIfMissing is false/,
    );

    expect(fs.existsSync(target)).toBe(false);
  });

  it('should throw when the path is not relative to the workspace', async () => {
    await expect(
      action.handler({
        ...mockContext,
        input: { files: [{ path: '../../etc/x', content: 'x' }] },
      }),
    ).rejects.toThrow(
      /Relative path is not allowed to refer to a directory outside its parent/,
    );

    await expect(
      action.handler({
        ...mockContext,
        input: { files: [{ path: '/foo/../../../index.js', content: 'x' }] },
      }),
    ).rejects.toThrow(
      /Relative path is not allowed to refer to a directory outside its parent/,
    );
  });

  it('should throw an error when files is not an array', async () => {
    await expect(
      action.handler({
        ...mockContext,
        input: { files: undefined } as any,
      }),
    ).rejects.toThrow(/files must be an Array/);

    await expect(
      action.handler({
        ...mockContext,
        input: { files: {} } as any,
      }),
    ).rejects.toThrow(/files must be an Array/);

    await expect(
      action.handler({
        ...mockContext,
        input: { files: '' } as any,
      }),
    ).rejects.toThrow(/files must be an Array/);

    await expect(
      action.handler({
        ...mockContext,
        input: { files: null } as any,
      }),
    ).rejects.toThrow(/files must be an Array/);
  });

  it('should throw an error when a file entry is missing path or content', async () => {
    await expect(
      action.handler({
        ...mockContext,
        input: { files: ['unit-test-a.js'] } as any,
      }),
    ).rejects.toThrow(/each file must have a path and content property/);

    await expect(
      action.handler({
        ...mockContext,
        input: { files: [{ path: 'unit-test-a.js' }] } as any,
      }),
    ).rejects.toThrow(/each file must have a path and content property/);

    await expect(
      action.handler({
        ...mockContext,
        input: { files: [{ content: 'x' }] } as any,
      }),
    ).rejects.toThrow(/each file must have a path and content property/);

    const numberContent = action.handler({
      ...mockContext,
      input: { files: [{ path: 'unit-test-a.js', content: 42 }] } as any,
    });

    await expect(numberContent).rejects.toThrow(InputError);
    await expect(numberContent).rejects.toThrow(
      /each file must have a path and content property/,
    );

    const objectContent = action.handler({
      ...mockContext,
      input: {
        files: [
          { path: 'unit-test-a.js', content: { toString: () => ' appended' } },
        ],
      } as any,
    });

    await expect(objectContent).rejects.toThrow(InputError);
    await expect(objectContent).rejects.toThrow(
      /each file must have a path and content property/,
    );

    const nullContent = action.handler({
      ...mockContext,
      input: { files: [{ path: 'unit-test-a.js', content: null }] } as any,
    });

    await expect(nullContent).rejects.toThrow(InputError);
    await expect(nullContent).rejects.toThrow(
      /each file must have a path and content property/,
    );

    const numberPath = action.handler({
      ...mockContext,
      input: { files: [{ path: 42, content: ' appended' }] } as any,
    });

    await expect(numberPath).rejects.toThrow(InputError);
    await expect(numberPath).rejects.toThrow(
      /each file must have a path and content property/,
    );

    // An empty path resolves to the workspace directory, which must not be
    // accepted as a file target.
    const emptyPath = action.handler({
      ...mockContext,
      input: { files: [{ path: '', content: ' appended' }] } as any,
    });

    await expect(emptyPath).rejects.toThrow(InputError);
    await expect(emptyPath).rejects.toThrow(
      /each file must have a path and content property/,
    );

    expect(
      await fs.readFile(resolvePath(workspacePath, 'unit-test-a.js'), 'utf-8'),
    ).toEqual('hello');

    await expect(
      action.handler({
        ...mockContext,
        input: { files: [{ path: 'unit-test-a.js', content: '' }] },
      }),
    ).resolves.not.toThrow();

    expect(
      await fs.readFile(resolvePath(workspacePath, 'unit-test-a.js'), 'utf-8'),
    ).toEqual('hello');
  });

  it('should append to multiple files in a single step', async () => {
    await action.handler({
      ...mockContext,
      input: {
        files: [
          { path: 'unit-test-a.js', content: '-a' },
          { path: 'unit-test-b.js', content: '-b' },
          { path: 'batch/created.txt', content: 'batched' },
        ],
      },
    });

    expect(
      await fs.readFile(resolvePath(workspacePath, 'unit-test-a.js'), 'utf-8'),
    ).toEqual('hello-a');
    expect(
      await fs.readFile(resolvePath(workspacePath, 'unit-test-b.js'), 'utf-8'),
    ).toEqual('world-b');
    expect(
      await fs.readFile(
        resolvePath(workspacePath, 'batch/created.txt'),
        'utf-8',
      ),
    ).toEqual('batched');
  });

  it('should not throw for a missing file during a dry run', async () => {
    const target = resolvePath(workspacePath, 'missing-in-dry-run.txt');

    expect(fs.existsSync(target)).toBe(false);

    // The dry run flag is spread onto the context rather than passed to
    // `createMockActionContext`, which propagates only a fixed set of options
    // and would silently drop it, leaving this case vacuous.
    await expect(
      action.handler({
        ...mockContext,
        isDryRun: true,
        input: {
          files: [
            {
              path: 'missing-in-dry-run.txt',
              content: 'x',
              createIfMissing: false,
            },
          ],
        },
      }),
    ).resolves.not.toThrow();

    expect(fs.existsSync(target)).toBe(false);
  });
});
