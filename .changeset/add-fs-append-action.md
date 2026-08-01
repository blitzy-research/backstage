---
'@backstage/plugin-scaffolder-backend': patch
---

Added a new `fs:append` action that appends content to the end of one or more files in the workspace, leaving any existing content in place. It accepts a non-empty `files` array whose entries each carry a workspace-relative `path` and the `content` to append, plus an optional `createIfMissing` flag that defaults to `true` and creates the file along with any missing parent directories; set it to `false` to make a missing file an error instead.
