# Third-Party Notices

WaveMint includes the third-party software listed below. Each component is
distributed under its own license. The full license texts for the bundled
command-line tools are installed in `resources\bin\licenses\` inside the
WaveMint installation folder. Electron's and Chromium's licenses are installed
next to `WaveMint.exe` (`LICENSE.electron.txt`, `LICENSES.chromium.html`).

WaveMint does not modify any of these components.

## Bundled command-line tools

### yt-dlp 2026.08.19

- Source: https://github.com/yt-dlp/yt-dlp/tree/2026.08.19
- Binary: official Windows executable `yt-dlp.exe` from the yt-dlp GitHub release
- License: The Unlicense (`licenses\yt-dlp-LICENSE.txt`). The executable also
  bundles Python, yt-dlp-ejs and other libraries under their own licenses,
  compiled by the yt-dlp project in `licenses\yt-dlp-THIRD_PARTY_LICENSES.txt`.
- In-app updates: WaveMint can download newer official `yt-dlp.exe` releases
  (Settings → Extraction Engine) into `%APPDATA%\WaveMint\engine\`. They are
  unmodified upstream files under the same licenses, verified against yt-dlp's
  signed checksums using yt-dlp's public release signing key
  (`electron\trust\yt-dlp-signing-key.asc`, from the yt-dlp repository).

### Deno 2.9.7

- Source: https://github.com/denoland/deno/tree/v2.9.7
- Binary: official `deno-x86_64-pc-windows-msvc.zip` from the Deno GitHub release
- License: MIT (`licenses\deno-LICENSE.md`)
- Used only by yt-dlp to run YouTube's JavaScript challenges locally.

### FFmpeg n8.1.3-9-g29e619e767 (LGPL build)

- Source code: FFmpeg commit `29e619e767cde9045a75c29bc9a8278ae7b3a98b` on the
  8.1 release branch: https://github.com/FFmpeg/FFmpeg/tree/29e619e767cde9045a75c29bc9a8278ae7b3a98b
  (mirror of https://git.ffmpeg.org/ffmpeg.git)
- Binary: `ffmpeg-n8.1.3-9-g29e619e767-win64-lgpl-shared-8.1.zip` from
  https://github.com/BtbN/FFmpeg-Builds (release `autobuild-2026-09-30-13-08`).
  The build scripts, including the exact versions of every library linked into
  the DLLs, are published at https://github.com/BtbN/FFmpeg-Builds.
- License: GNU Lesser General Public License version 3
  (`licenses\FFmpeg-LICENSE.txt`), which incorporates the GNU General Public
  License version 3 (`licenses\FFmpeg-COPYING.GPLv3.txt`). This build is
  configured with `--enable-version3` and without GPL-only components.
- FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.
- WaveMint runs `ffmpeg.exe` and `ffprobe.exe` as separate programs. The FFmpeg
  libraries are shipped as separate DLLs (`avcodec`, `avformat`, `avutil`,
  `avfilter`, `avdevice`, `swresample`, `swscale`) and can be replaced.

## Application libraries

| Component | License | Source |
|---|---|---|
| Electron | MIT | https://github.com/electron/electron |
| Chromium (via Electron) | BSD-3-Clause and others, see `LICENSES.chromium.html` | https://www.chromium.org |
| React, React DOM, Scheduler | MIT | https://github.com/facebook/react |
| Poppins typeface (`@fontsource/poppins`) | SIL Open Font License 1.1 | https://github.com/itfoundry/Poppins |

### MIT License (React, React DOM, Scheduler)

Copyright (c) Meta Platforms, Inc. and affiliates.

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

### SIL Open Font License 1.1 (Poppins)

Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
The full license text is installed as `resources\licenses\Poppins-OFL.txt`
and is also available at https://openfontlicense.org. The font is used
unmodified.
