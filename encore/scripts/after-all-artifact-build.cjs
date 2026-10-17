// electron-builder runs this once everything is built (`afterAllArtifactBuild` in electron-builder.yml).
// It switches off Windows' redirection of AppData in the Microsoft Store package, so Show -> Open Data
// Folder works and uninstalling keeps the data: see scripts/patch-appx.mjs and STORE.md. Anything that
// isn't an .appx (the installer) is left alone. If the package can't be patched this throws, which
// fails the build: a Store package that still loses its data on uninstall must never come out of here.
module.exports = async function afterAllArtifactBuild(result) {
  const { patchAppx } = await import('./patch-appx.mjs');
  for (const file of result.artifactPaths ?? []) {
    if (!file.toLowerCase().endsWith('.appx')) continue;
    console.log(patchAppx(file) ? `  • patched ${file}: AppData redirection switched off` : `  • ${file} was already patched`);
  }
  return []; // no extra files to publish
};
