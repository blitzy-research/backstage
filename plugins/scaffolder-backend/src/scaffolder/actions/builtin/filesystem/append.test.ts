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

import { isAbsolute, resolve as resolvePath } from 'node:path';
import { inspect } from 'node:util';
import { createFilesystemAppendAction } from './append';
import { createFilesystemAppendAction as createFromBarrel } from './index';
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { InputError, NotAllowedError } from '@backstage/errors';
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
    // The error class is asserted alongside the message: a path escape must stay
    // the `NotAllowedError` that `resolveSafeChildPath` raises, so an
    // implementation that caught it and rethrew a plain `Error` carrying the same
    // text cannot satisfy this case.
    const relativeEscape = action.handler({
      ...mockContext,
      input: { files: [{ path: '../../etc/x', content: 'x' }] },
    });

    await expect(relativeEscape).rejects.toThrow(NotAllowedError);
    await expect(relativeEscape).rejects.toThrow(
      /Relative path is not allowed to refer to a directory outside its parent/,
    );

    // A second escape shape, which leaves the workspace by traversing back out of
    // a directory that really exists in it rather than by a leading `..` alone.
    // Absolute paths are not asserted here: they are rejected by the handler's own
    // workspace-relative guard before they ever reach the resolver, which the
    // case below covers.
    const nestedEscape = action.handler({
      ...mockContext,
      input: { files: [{ path: 'a-folder/../../escape.txt', content: 'x' }] },
    });

    await expect(nestedEscape).rejects.toThrow(NotAllowedError);
    await expect(nestedEscape).rejects.toThrow(
      /Relative path is not allowed to refer to a directory outside its parent/,
    );
  });

  it('should throw when the path is absolute rather than workspace-relative', async () => {
    // `resolveSafeChildPath` accepts an absolute path whenever it resolves inside
    // the base directory, so an absolute path that points at a real file in the
    // workspace is exactly the input the handler's own guard has to reject. A
    // seeded file is used so that the assertions below can also prove that
    // nothing was appended to it.
    const insideWorkspace = resolvePath(workspacePath, 'unit-test-a.js');

    expect(isAbsolute(insideWorkspace)).toBe(true);
    expect(fs.existsSync(insideWorkspace)).toBe(true);

    const absoluteInside = action.handler({
      ...mockContext,
      input: { files: [{ path: insideWorkspace, content: ' appended' }] },
    });

    await expect(absoluteInside).rejects.toThrow(InputError);
    await expect(absoluteInside).rejects.toThrow(
      /the path of the file at index 0 of the files input must be workspace-relative/,
    );

    expect(await fs.readFile(insideWorkspace, 'utf-8')).toEqual('hello');

    // The rejection escapes the handler and is audited outside the redaction that
    // ctx.logger output is subject to, so it must not repeat the path it rejects.
    const rejection: Error = await absoluteInside.then(
      () => {
        throw new Error('the handler was expected to reject');
      },
      (err: Error) => err,
    );

    expect(rejection.message).not.toContain(insideWorkspace);
    expect(rejection.message).not.toContain(workspacePath);

    // An absolute path that points outside the workspace is rejected by the same
    // guard, so it never reaches the resolver either.
    for (const path of ['/foo/../../../index.js', '/etc/passwd']) {
      const absoluteOutside = action.handler({
        ...mockContext,
        input: { files: [{ path, content: 'x' }] },
      });

      await expect(absoluteOutside).rejects.toThrow(InputError);
      await expect(absoluteOutside).rejects.toThrow(
        /must be workspace-relative/,
      );
    }
  });

  it('should throw an error when files is not an array', async () => {
    // Each value asserts the error class as well as the message, so a guard that
    // stopped raising `InputError` and threw a plain `Error` with the same text
    // would fail here rather than pass unnoticed.
    const undefinedFiles = action.handler({
      ...mockContext,
      input: { files: undefined } as any,
    });

    await expect(undefinedFiles).rejects.toThrow(InputError);
    await expect(undefinedFiles).rejects.toThrow(/files must be an Array/);

    const objectFiles = action.handler({
      ...mockContext,
      input: { files: {} } as any,
    });

    await expect(objectFiles).rejects.toThrow(InputError);
    await expect(objectFiles).rejects.toThrow(/files must be an Array/);

    const stringFiles = action.handler({
      ...mockContext,
      input: { files: '' } as any,
    });

    await expect(stringFiles).rejects.toThrow(InputError);
    await expect(stringFiles).rejects.toThrow(/files must be an Array/);

    const nullFiles = action.handler({
      ...mockContext,
      input: { files: null } as any,
    });

    await expect(nullFiles).rejects.toThrow(InputError);
    await expect(nullFiles).rejects.toThrow(/files must be an Array/);
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
    const laterTarget = resolvePath(workspacePath, 'unit-test-b.js');

    // `ctx.isDryRun` is only ever true for an action that advertises dry run
    // support, so the leniency asserted below is unreachable without this flag.
    expect(action.supportsDryRun).toBe(true);

    expect(fs.existsSync(target)).toBe(false);
    expect(await fs.readFile(laterTarget, 'utf-8')).toEqual('world');

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
            // Deliberately ordered after the skipped entry: the handler must
            // continue to the remaining entries, so a regression that returned
            // early instead of continuing would leave this file untouched.
            { path: 'unit-test-b.js', content: '-dry' },
          ],
        },
      }),
    ).resolves.not.toThrow();

    expect(fs.existsSync(target)).toBe(false);
    expect(await fs.readFile(laterTarget, 'utf-8')).toEqual('world-dry');

    // A dry run never relaxes path safety: the leniency above is scoped to a
    // missing target, and an escaping path still fails with the untouched
    // `NotAllowedError` from `resolveSafeChildPath`.
    const escapingInDryRun = action.handler({
      ...mockContext,
      isDryRun: true,
      input: { files: [{ path: '../../etc/x', content: 'x' }] },
    });

    await expect(escapingInDryRun).rejects.toThrow(NotAllowedError);
    await expect(escapingInDryRun).rejects.toThrow(
      /Relative path is not allowed to refer to a directory outside its parent/,
    );
  });

  it('should keep caller-derived paths out of the error that escapes the handler', async () => {
    // Both routes a native filesystem failure can take are covered, because both
    // of them rethrow through the same sanitizer. Every native error names the
    // resolved path in its own message and in an enumerable `path` field.
    const scenarios = [
      {
        // A seeded directory: the path resolves safely, then the append itself
        // fails, which is the branch that writes to the workspace.
        callerPath: 'a-folder',
        code: 'EISDIR',
      },
      {
        // A child of the seeded file `unit-test-a.js`: a regular file cannot
        // contain a directory, so the path cannot be resolved at all. The failure
        // is a native error rather than the `NotAllowedError` of an escape, so it
        // is sanitized rather than propagated untouched.
        callerPath: 'unit-test-a.js/nested/child.txt',
        code: 'ENOTDIR',
      },
    ];

    for (const { callerPath, code } of scenarios) {
      const errorLog = jest.spyOn(mockContext.logger, 'error');

      const escaping: Error & { cause?: unknown } = await action
        .handler({
          ...mockContext,
          input: { files: [{ path: callerPath, content: 'x' }] },
        })
        .then(
          () => {
            throw new Error(
              `the handler was expected to reject for ${callerPath}`,
            );
          },
          (err: Error & { cause?: unknown }) => err,
        );

      // The replacement message names the offending entry by its index in the
      // files input and carries only the errno code, which is never caller
      // derived.
      expect(escaping.message).toEqual(
        `Failed to append content to the file at index 0 of the files input (${code})`,
      );

      // A path is step input rendered with task and environment secrets in scope,
      // and this error is handed to the auditor, whose serialization is not
      // subject to the redaction that ctx.logger output is. The two strings below
      // are the shapes that serialization takes: the own enumerable fields, and a
      // full inspection that also covers the stack and the cause chain. Neither
      // may name a path, so the raw failure is not carried as a cause either.
      expect(escaping.cause).toBeUndefined();

      const audited = `${JSON.stringify(escaping)}${inspect(escaping, {
        depth: Infinity,
      })}`;

      expect(audited).not.toContain(callerPath);
      expect(audited).not.toContain(resolvePath(workspacePath, callerPath));
      expect(audited).not.toContain(workspacePath);

      // The failure is reported exactly once, with the same path-free text as the
      // escaping error and with no second argument: handing the native error to
      // the logger would reinstate the resolved path through its message and its
      // enumerable `path` field.
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(escaping.message);

      errorLog.mockRestore();
    }
  });

  it('should keep control characters and paths out of every log message', async () => {
    // A file name may legitimately contain carriage returns, line feeds and
    // terminal escape sequences, none of which the task logger's secret redaction
    // neutralizes. Interpolating one into a log message would let a template forge
    // multiline log records or rewrite terminal output, so every branch that logs
    // has to name the entry by its index instead of by its path.
    const controlName = 'control\r\n\u001b[31m\u0007name.txt';
    const seededControlDir = `dir-${controlName}`;

    mockDir.setContent({
      [workspacePath]: {
        'unit-test-a.js': 'hello',
        [`file-${controlName}`]: 'seeded',
        [seededControlDir]: { 'file.md': 'content' },
      },
    });

    const infoLog = jest.spyOn(mockContext.logger, 'info');
    const warnLog = jest.spyOn(mockContext.logger, 'warn');
    const errorLog = jest.spyOn(mockContext.logger, 'error');

    const loggedMessages = () =>
      [infoLog, warnLog, errorLog].flatMap(spy =>
        spy.mock.calls.map(call => call.join(' ')),
      );

    const expectControlSafe = (callerPath: string) => {
      const messages = loggedMessages();

      expect(messages).not.toEqual([]);

      for (const message of messages) {
        // No C0 or C1 control character, so a single log record cannot be split
        // into several or carry a terminal escape sequence.
        // eslint-disable-next-line no-control-regex
        expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);

        // Neither the caller's path nor anything it resolves to is disclosed, so
        // a rendered secret cannot reach a log record through a file name and the
        // layout of the workspace stays private.
        expect(message).not.toContain(controlName);
        expect(message).not.toContain(callerPath);
        expect(message).not.toContain(workspacePath);
      }
    };

    const clearLogs = () => {
      infoLog.mockClear();
      warnLog.mockClear();
      errorLog.mockClear();
    };

    // The success branch: the file is created, so the `info` line is emitted.
    const created = `created-${controlName}`;

    await action.handler({
      ...mockContext,
      input: { files: [{ path: created, content: 'x' }] },
    });

    expect(fs.existsSync(resolvePath(workspacePath, created))).toBe(true);
    expect(infoLog).toHaveBeenCalledWith(
      'Content appended to the file at index 0 of the files input successfully',
    );
    expectControlSafe(created);
    clearLogs();

    // The dry-run branch: a missing strict target is skipped with a `warn` line.
    const missing = `missing-${controlName}`;

    await action.handler({
      ...mockContext,
      isDryRun: true,
      input: {
        files: [{ path: missing, content: 'x', createIfMissing: false }],
      },
    });

    expect(fs.existsSync(resolvePath(workspacePath, missing))).toBe(false);
    expect(warnLog).toHaveBeenCalledWith(
      'Skipped the file at index 0 of the files input during a dry run, it does not exist and createIfMissing is false',
    );
    expectControlSafe(missing);
    clearLogs();

    // The filesystem-failure branch: appending to a directory fails with EISDIR
    // after the path has resolved.
    await expect(
      action.handler({
        ...mockContext,
        input: { files: [{ path: seededControlDir, content: 'x' }] },
      }),
    ).rejects.toThrow(
      'Failed to append content to the file at index 0 of the files input (EISDIR)',
    );

    expectControlSafe(seededControlDir);
    clearLogs();

    // The resolver-failure branch: a regular file cannot contain a directory, so
    // resolution itself fails with ENOTDIR before any write is attempted.
    const underFile = `file-${controlName}/nested/child.txt`;

    await expect(
      action.handler({
        ...mockContext,
        input: { files: [{ path: underFile, content: 'x' }] },
      }),
    ).rejects.toThrow(
      'Failed to append content to the file at index 0 of the files input (ENOTDIR)',
    );

    expectControlSafe(underFile);
  });
});
