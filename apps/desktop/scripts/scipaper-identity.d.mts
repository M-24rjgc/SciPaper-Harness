/** The application identifier; an installed copy only updates to releases that carry the same one. */
export const SCIPAPER_APP_ID: string

/** The GitHub repository whose Releases carry the installers and the update metadata. */
export const SCIPAPER_RELEASES: { readonly owner: string, readonly repo: string }

/**
 * The installer file name electron-builder writes for a Windows x64 version.
 * @param version - The Desktop version.
 * @returns The installer's file name.
 */
export function scipaperInstallerName(version: string): string
