# Third-party notices

Alexandria Scoreboard is licensed under the Apache License 2.0 (see `LICENSE` and `NOTICE`). It uses the third-party
components below. Names, versions and licences are taken from `package-lock.json` and the packages' own
`package.json` / `LICENSE` files; copyright lines are quoted from each package's `LICENSE` file.

No component under a GPL-family (GPL, LGPL, AGPL) licence is used or distributed.

## Components that ship with the app or are required to run it

| Component | Version | Licence | Copyright |
|---|---|---|---|
| Electron (desktop runtime; only for `npm run desktop` and the Windows packages) | 45.3.0 | MIT | Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. |
| web-tree-sitter | 0.27.2 | MIT | Copyright (c) 2018 Max Brunsfeld |
| tree-sitter-javascript | 0.25.0 | MIT | Copyright (c) 2014 Max Brunsfeld |
| node-addon-api (dependency of tree-sitter-javascript; install-time metadata only) | 8.9.2 | MIT | Copyright (c) 2017 Node.js API collaborators |
| node-gyp-build (dependency of tree-sitter-javascript; install-time metadata only) | 4.8.4 | MIT | Copyright (c) 2017 Mathias Buus |

### Electron, Chromium and Node.js

Electron bundles Chromium and Node.js together with their own dependencies. Their licence notices are shipped inside
the Electron distribution itself, in the file `LICENSES.chromium.html` (next to the Electron executable in
the packaged app). Windows packages built from this repository contain the unmodified Electron runtime and therefore
that file; redistributors of a packaged build must keep it. Electron's own `LICENSE` file is also included in the
distribution.

The Node.js runtime used by `npm start` and the test suite is installed separately by the user and is not distributed
by this project.

### MIT licence text (Electron, web-tree-sitter, tree-sitter-javascript, node-addon-api, node-gyp-build)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Build tools (not distributed)

`electron-builder` (MIT) and its dependency tree are used only to build the Windows packages. They are listed as
development dependencies, are not part of the application, and are not included in any package this project
distributes. Their licences (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0, 0BSD and others, none
GPL-family) are recorded per package in `package-lock.json`.
