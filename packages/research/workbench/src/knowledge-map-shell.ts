/** What the domain map plugin answers while no map data is wired into it. */
import type { MapOverlayPage, MapViewPage } from './types.ts'

/**
 * The single read behind both map commands. It reports that no map has been built; the map engine replaces it
 * together with {@link MapViewPage} and {@link MapOverlayPage}.
 * @returns the page that says the map is not built.
 */
export function mapNotBuilt(): MapViewPage & MapOverlayPage {
  return { built: false }
}
