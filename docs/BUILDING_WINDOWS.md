# Building and running on Windows

Alexandria Scoreboard is a development preview. There are no official binaries yet. You can run it from source
(`npm start` or `npm run desktop`) or build a local package as described here.

## Development builds versus production releases

- **Development builds** are packages you build yourself from source. They are unsigned. Windows Smart App Control or
  SmartScreen may block unsigned executables on some machines.
- **Production releases** will be code-signed and published on the project's Releases page. Public binaries should not
  be distributed unsigned.

## Packaging approach

The Windows packages ship the **unmodified official Electron executable**, only renamed. `package.json` sets
`signAndEditExecutable: false` and `asar: false`:

- Editing an executable (icon, version info, asar-integrity resource) produces a new unsigned binary hash with no
  reputation, which Smart App Control blocks. The untouched Electron runtime keeps Electron's own reputation and
  signature.
- Trade-offs: the `.exe` shows Electron's file icon and version information (the window, taskbar and shortcuts use the
  Scoreboard icon), and the application code ships as plain files under `resources/app` instead of an asar archive.

## Commands

```
npm install
npm run dist:zip       # portable ZIP for Windows x64 in dist/
npm run dist:arm64     # portable ZIP for Windows on ARM64 in dist/
```

Output file names follow `Alexandria-Scoreboard-<version>-win-<arch>.zip`. Unzip anywhere and run
`Alexandria Scoreboard.exe`; no installer and no administrator rights are needed.

## Verifying a build

1. **Architecture.** Use a Node.js and npm that match the target (an ARM64 Node for the ARM64 package) and read the
   machine field of the produced executable's PE header: `0x8664` is x64, `0xAA64` is ARM64 (for example with
   `dumpbin /headers "Alexandria Scoreboard.exe"` from the Visual Studio tools).
2. **Hash.** The renamed Electron executable must be byte-identical to the official one for the same Electron version:
   compare `Get-FileHash` of the packaged executable with the executable inside the official Electron release archive
   for the same version and architecture.
3. **Smoke test.** `Alexandria Scoreboard.exe --smoke=out.png` loads the window, writes a screenshot and exits with
   code 0.

## Smart App Control

If Windows reports "An Application Control policy has blocked this file" (Code Integrity events 3033 or 3077), the
file was not trusted by Smart App Control. Do not weaken your machine's security settings to run a development build.
Options, in order of preference:

1. Run from source with `npm run desktop` (uses the Electron already installed in `node_modules`).
2. Use the browser version, `npm start`, which needs no executable at all.
3. Wait for a signed production release.

## Signing

Signing requires a code-signing certificate and is applied to the final packages. Signing changes the executable, so it
is only done for production releases, never on development builds.
