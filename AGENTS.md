# Independent Linux Desktop

Never modify tracked files in the upstream source checkout, transform upstream source text, patch compiled upstream code, spoof `process.platform`, or depend on the earlier patched Arch build. Compose exported upstream desktop components in the carrier and reuse its private Host unchanged. Verify the upstream commit and clean tracked tree before and after builds.

Keep all implementation in this repository. Do not replace the user's `dsh`, publish packages, register URL handlers, or change real profiles without explicit authorization. GUI tests use isolated DSH_HOME and Electron user data. Preserve Chromium sandboxing.

Commands: `npm test`, `npm run build`, `npm run test:gui`, `npm run verify:upstream`. Report parity gaps explicitly; passing the smoke test does not establish Windows parity or multi-distribution support.
