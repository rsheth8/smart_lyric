# Local TV review — September 14, 2026

The native Apple TV 4K simulator build passed 28 app/layout tests and all five
remote-navigation journeys. The bundled Barlow Condensed font was verified at
runtime. Build output and tests contained no failing assertions.

The remote journeys cover both stage views, hide/reveal focus, idle hiding,
paused controls, panels remaining open during playback, timing adjustments,
return focus, and Spotify pairing/back navigation. Pairing uses a deterministic
fixture; it is not a live Spotify authorization test.

The home and immersive stage captures in this directory are native simulator
screenshots. The demo uses original text, including a long hold and a duet line.

The current review is local, as requested. Earlier physical-TV testing exposed
focus movement across the control deck; directional focus was then made explicit.
The final changes have passed in the simulator but have not been revalidated on
physical hardware. No claim of measured physical-TV frame rate is made.
