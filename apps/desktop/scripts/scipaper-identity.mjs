/** SciPaper Harness's release identity, shared by the packaging configuration and the release script. */

/** The application identifier; an installed copy only updates to releases that carry the same one. */
export const SCIPAPER_APP_ID = 'io.github.m-24rjgc.scipaper-harness'

/** The GitHub repository whose Releases carry the installers and the update metadata. */
export const SCIPAPER_RELEASES = Object.freeze({ owner: 'M-24rjgc', repo: 'SciPaper-Harness' })

/**
 * The installer file name electron-builder writes for a Windows x64 version.
 * @param {string} version - The Desktop version.
 * @returns {string} The installer's file name.
 */
export function scipaperInstallerName(version) {
  return `scipaper-harness-${version}-win-x64.exe`
}
