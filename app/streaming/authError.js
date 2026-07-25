// Turn a Spotify OAuth `?error=` code into an actionable, human message.
//
// Pure and DOM-free so it unit-tests without a browser. Note: the most common
// setup failure — a redirect_uri not registered in the Spotify Dashboard —
// never reaches this code, because Spotify shows "INVALID_CLIENT: Invalid
// redirect URI" on its OWN page and does not redirect back. So the guidance
// here names the exact redirect URI regardless, and beginSpotifyLogin also logs
// it before navigating, giving the user something concrete to compare.

/**
 * @param {string|null|undefined} error  the `error` query param Spotify returned
 * @param {string} redirectUri  the exact redirect URI the app used
 * @returns {string|null}  a message to show, or null if there was no error
 */
export function describeAuthError(error, redirectUri) {
  if (!error) return null;
  if (error === 'access_denied') {
    return 'Spotify permission was declined. Click Connect Spotify to try again.';
  }
  const uri = redirectUri || 'the app’s redirect URI';
  return `Spotify sign-in failed (${error}). If this mentions the redirect URI, register ${uri} exactly — including the trailing slash — in your Spotify Developer Dashboard.`;
}
