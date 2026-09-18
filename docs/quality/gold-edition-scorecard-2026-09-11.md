# Bar4Bar · Gold Edition coverage

Playlist: [Gold Edition](https://open.spotify.com/playlist/37i9dQZF1DWXnexX7CktaI). Frozen September 11, 2026: **150 exact Spotify track IDs** in playlist order.

**Availability is measured. Vocal timing accuracy is not yet measured.** These checks run the production Apple TV lyric client on the Mac against the live service; they do not play or film the TV.

| Result | Before search fix | After search fix |
| --- | ---: | ---: |
| Word timestamps | 71 | 94 |
| Estimated words | 79 | 56 |
| Audio-refined, mixed | 0 | 0 |
| Unavailable | 0 | 0 |
| Human-verified accurate recordings | Not measured | Not measured |

Word timestamp availability: **62.7%** of the complete playlist. No songs are omitted from the denominator. Having word timestamps is not an accuracy certification.

Live native audit completed 2026-09-11T16:15:52Z. Observed fetch time: median 879 ms; p95 2488 ms. This run may use warm provider/CDN caches and is not a cold-start latency guarantee.

## What changed

The server now searches a collaboration by its title and lead artist. Featured-artist and parenthesized “with” credits are removed from the search title; remix, live, and version labels remain. Results from unrelated artists and grossly mismatched durations are rejected before lyric retrieval. Up to three entries with matching titles/artist credits and closely matching durations are checked in parallel, because a single can lack word timing that exists on its album entry.

Recovered word-timestamp availability for **23 songs**:

- [Thinkin Bout You](https://open.spotify.com/track/7DfFc7a6Rwfi3YQMRbDMau) — Frank Ocean
- [Don't](https://open.spotify.com/track/3pXF1nA74528Edde4of9CC) — Bryson Tiller
- [Sky Walker (feat. Travis Scott)](https://open.spotify.com/track/5WoaF1B5XIEnWfmb5NZikf) — Miguel, Travis Scott
- [No Guidance (feat. Drake)](https://open.spotify.com/track/6XHVuErjQ4XNm6nDPVCxVX) — Chris Brown, Drake
- [Blessed](https://open.spotify.com/track/2XjoHA58XD0t3qye8bYGU8) — Daniel Caesar
- [The Weekend](https://open.spotify.com/track/6gU9OKjOE7ghfEd55oRO57) — SZA
- [Essence (feat. Tems)](https://open.spotify.com/track/5FG7Tl93LdH117jEKYl3Cm) — Wizkid, Tems
- [Nights Like This (feat. Ty Dolla $ign)](https://open.spotify.com/track/6ZRuF2n1CQxyxxAAWsKJOy) — Kehlani, Ty Dolla $ign
- [Trip](https://open.spotify.com/track/6CTWathupIiDs7U4InHnDA) — Ella Mai
- [Could've Been (feat. Bryson Tiller)](https://open.spotify.com/track/6oEVnWKgPqIEPc53OYDNqG) — H.E.R., Bryson Tiller
- [Playing Games (with Bryson Tiller) - Extended Version](https://open.spotify.com/track/2xyx0o4xNOLLjBSbOOdcbA) — Summer Walker, Bryson Tiller
- [While We're Young](https://open.spotify.com/track/4mL59LVbKgOpEACxraGYdr) — Jhené Aiko
- [No Love (with SZA)](https://open.spotify.com/track/08SB2OtZkaliju77WYEKxk) — Summer Walker, SZA
- [Easy - Remix](https://open.spotify.com/track/4CMrdHWqic0usIZfTrKoI3) — DaniLeigh, Chris Brown
- [She Don't (feat. Ty Dolla $Ign)](https://open.spotify.com/track/01JPQ87UHeGysPVwTqMJHK) — Ella Mai, Ty Dolla $ign
- [Always n Forever (feat. Lil Baby)](https://open.spotify.com/track/6dbENHQHHtWRai4snSvy2w) — Mariah the Scientist, Lil Baby
- [Best Part (feat. H.E.R.)](https://open.spotify.com/track/4OBZT9EnhYIV17t4pGw7ig) — Daniel Caesar, H.E.R.
- [HEATED](https://open.spotify.com/track/1w7cgGZR86yWz1pA2puVJD) — Beyoncé
- [On My Mama](https://open.spotify.com/track/7DswEZZthZ6piQpL25qGAM) — Victoria Monét
- [Shea Butter Baby (with J. Cole)](https://open.spotify.com/track/5BOBHIBuzvQuIYL1E1nDzl) — Ari Lennox, J. Cole
- [True Love (feat. Tay Iwar & Projexx)](https://open.spotify.com/track/4204hwPYuToiuSunPFUoML) — Wizkid, Tay Iwar, Projexx
- [Wild Side (feat. Cardi B)](https://open.spotify.com/track/2vXgyN14LX2zl7JEASw242) — Normani, Cardi B
- [Come Through (feat. Chris Brown)](https://open.spotify.com/track/3krZxyBsWEHfEfJegYaWTd) — H.E.R., Chris Brown

Previously word-timed songs falling back after the change: **0**.


## Timing and recording review

Spotify track IDs and album names identify the intended test recordings. The playlist UI exposes duration only to whole seconds; this inventory does not claim millisecond duration or ISRC verification. Matching lyrics are still selected by metadata and duration, so remixes, clean versions, and alternate edits need listening checks.

- [Lost](https://open.spotify.com/track/3GZD6HmiNUhxXYf8Gch723) — provider duration differs by -6.0 seconds.
- [Pyramids](https://open.spotify.com/track/4QhWbupniDd44EDtnh2bFJ) — some word spans exceed the displayed recording length by more than three seconds.
- [TYRANT](https://open.spotify.com/track/5mUlozUYpdmXVPkj4BW8cA) — some word spans exceed the displayed recording length by more than three seconds.

These are review flags, not confirmed acoustic error measurements. Do not mark these songs verified based on a provider response.

## Next acceptance pass

Start the manual pass with the recovered collaborations, then Pyramids and Lost for recording/timestamp anomalies, and Pink + White and have to. for missing word timing. Use the Spotify links below to retain the exact editions.

For each recording: obtain matching authorized audio and lyrics, mark word boundaries, have a second listener review ambiguous vocals, and measure word coverage plus timing error. Keep missing words in the coverage denominator. Compare absolute timing and offset-adjusted timing separately. Then test playback, pause/resume, seeking, and remote navigation on Apple TV with the actual audio output.

The prepared-timing service can supply reviewed recordings once ready. No new alignment files, licensed-provider subscriptions, or accuracy certifications were created in this pass.

## Every song

| # | Song | Artist | Before | Now | Selected source | Review |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | [A Couple Minutes](https://open.spotify.com/track/312z6PZ8wwREck8613PkJk) | Olivia Dean | Estimated words | Estimated words | lrc | Accuracy pending |
| 2 | [Folded](https://open.spotify.com/track/0bxPRWprUVpQK0UFcddkrA) | Kehlani | Estimated words | Estimated words | lrc | Accuracy pending |
| 3 | [Sure Thing](https://open.spotify.com/track/0JXXNGljqupsJaZsgSbMZV) | Miguel | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 4 | [It Depends (feat. Bryson Tiller)](https://open.spotify.com/track/0t3pcqgBjuAVBgY2oEUIlH) | Chris Brown, Bryson Tiller | Estimated words | Estimated words | lrc | Accuracy pending |
| 5 | [Miami (feat. Leon Thomas)](https://open.spotify.com/track/2egIlhalVEVQhvt9W11u82) | Odeal, Leon Thomas | Estimated words | Estimated words | lrc | Accuracy pending |
| 6 | [Pink + White](https://open.spotify.com/track/3xKsf9qdS1CyvXSMEid6g8) | Frank Ocean | Estimated words | Estimated words | lrc | Accuracy pending |
| 7 | [MUTT (feat. Chris Brown) [CB REMIX]](https://open.spotify.com/track/08M5qLQy0oUNrTMQv4xQac) | Leon Thomas, Chris Brown | Estimated words | Estimated words | lrc | Accuracy pending |
| 8 | [Snooze](https://open.spotify.com/track/4iZ4pt7kvcaH6Yo8UoZ4s2) | SZA | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 9 | [Bad Habit](https://open.spotify.com/track/4k6Uh1HXdhtusDW5y8Gbvy) | Steve Lacy | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 10 | [have to.](https://open.spotify.com/track/55Doxe1XJGnB88uYpLf6xW) | Brent Faiyaz | Estimated words | Estimated words | lrc | Accuracy pending |
| 11 | [Thinkin Bout You](https://open.spotify.com/track/7DfFc7a6Rwfi3YQMRbDMau) | Frank Ocean | Estimated words | Word timestamps | yrc | Accuracy pending |
| 12 | [Spend It](https://open.spotify.com/track/290eKCMBc9f9CcSLFuQrim) | Summer Walker | Estimated words | Estimated words | lrc | Accuracy pending |
| 13 | [YUKON](https://open.spotify.com/track/29iva9idM6rFCPUlu7Rhxl) | Justin Bieber | Estimated words | Estimated words | lrc | Accuracy pending |
| 14 | [TWENTIES](https://open.spotify.com/track/1NaSrCqTnZdlusQ82SJhGN) | GIVĒON | Estimated words | Estimated words | lrc | Accuracy pending |
| 15 | [Dark Red](https://open.spotify.com/track/3EaJDYHA0KnX88JvDhL9oa) | Steve Lacy | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 16 | [Here We Go (Uh Oh)](https://open.spotify.com/track/6SSSGEgfuqTP75xaNOwsTo) | Coco Jones | Estimated words | Estimated words | lrc | Accuracy pending |
| 17 | [telepatía](https://open.spotify.com/track/6tDDoYIxWvMLTdKpjFkc1B) | Kali Uchis | Estimated words | Estimated words | lrc | Accuracy pending |
| 18 | [Residuals](https://open.spotify.com/track/4t4rGgiVX7woTmlnW9SHJ7) | Chris Brown | Estimated words | Estimated words | lrc | Accuracy pending |
| 19 | [WHY](https://open.spotify.com/track/5bCWjEsrK0KUGMxPrjGJZg) | Sasha Keable | Estimated words | Estimated words | lrc | Accuracy pending |
| 20 | [DO 4 LOVE](https://open.spotify.com/track/3FImu2LpSuH6gDHBuFgIbS) | Snoh Aalegra | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 21 | [Smooth Operator - Single Version](https://open.spotify.com/track/1Hv1VTm8zeOeybub15mA2R) | Sade | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 22 | [Breakin' Dishes](https://open.spotify.com/track/46aZJc0z1HHHSFxaIRxYSP) | Rihanna | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 23 | [Leave The Door Open](https://open.spotify.com/track/02VBYrHfVwfEWXk5DXyf0T) | Bruno Mars, Anderson .Paak, Silk Sonic | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 24 | [Lost](https://open.spotify.com/track/3GZD6HmiNUhxXYf8Gch723) | Frank Ocean | Word timestamps | Word timestamps | yrc | duration mismatch |
| 25 | [Don't](https://open.spotify.com/track/3pXF1nA74528Edde4of9CC) | Bryson Tiller | Estimated words | Word timestamps | yrc | Accuracy pending |
| 26 | [Baby (Is it a Crime)](https://open.spotify.com/track/6NOrpcicPUh2eaj8bAD44u) | Rema | Estimated words | Estimated words | lrc | Accuracy pending |
| 27 | [Infrunami](https://open.spotify.com/track/0f8eRy9A0n6zXpKSHSCAEp) | Steve Lacy | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 28 | [Under The Influence](https://open.spotify.com/track/5IgjP7X4th6nMNDh4akUHb) | Chris Brown | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 29 | [Like a Tattoo](https://open.spotify.com/track/4PEGwWH4tL6H7dGl4uVSPg) | Sade | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 30 | [worst behaviour (feat. Kehlani)](https://open.spotify.com/track/5W67A7t9MWL3VtovrVrici) | kwn, Kehlani | Estimated words | Estimated words | lrc | Accuracy pending |
| 31 | [My Boo](https://open.spotify.com/track/68vgtRHr7iZHpzGpon6Jlo) | USHER, Alicia Keys | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 32 | [Pyramids](https://open.spotify.com/track/4QhWbupniDd44EDtnh2bFJ) | Frank Ocean | Word timestamps | Word timestamps | yrc | words beyond recording |
| 33 | [All I Want Is You (feat. J. Cole)](https://open.spotify.com/track/5VA4Ispp52EA1sOqzMz3Av) | Miguel, J. Cole | Estimated words | Estimated words | lrc | Accuracy pending |
| 34 | [Moonlight](https://open.spotify.com/track/0JmnkIqdlnUzPaf8sqBRs3) | Kali Uchis | Estimated words | Estimated words | lrc | Accuracy pending |
| 35 | [One Wish (feat. Childish Gambino)](https://open.spotify.com/track/3iHpwGD3h3Bj87KrJEBMI4) | Ravyn Lenae, Childish Gambino | Estimated words | Estimated words | lrc | Accuracy pending |
| 36 | [Die For You](https://open.spotify.com/track/2Ch7LmS7r2Gy2kc64wv3Bz) | The Weeknd | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 37 | [Love Songs - Bonus](https://open.spotify.com/track/6qL5UWxRSQYml9O99ozoLv) | Kaash Paige | Estimated words | Estimated words | lrclib | Accuracy pending |
| 38 | [Sky Walker (feat. Travis Scott)](https://open.spotify.com/track/5WoaF1B5XIEnWfmb5NZikf) | Miguel, Travis Scott | Estimated words | Word timestamps | yrc | Accuracy pending |
| 39 | [What You Heard](https://open.spotify.com/track/3a3dQOO19moXPeTt2PomoT) | Sonder | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 40 | [Dreamin](https://open.spotify.com/track/35sZOqVnTQNIGWGURrFdLh) | PARTYNEXTDOOR | Estimated words | Estimated words | lrc | Accuracy pending |
| 41 | [Broken Clocks](https://open.spotify.com/track/2fXwCWkh6YG5zU1IyvQrbs) | SZA | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 42 | [No Guidance (feat. Drake)](https://open.spotify.com/track/6XHVuErjQ4XNm6nDPVCxVX) | Chris Brown, Drake | Estimated words | Word timestamps | yrc | Accuracy pending |
| 43 | [Girl With The Tattoo Enter.lewd](https://open.spotify.com/track/1eUGmzzvahJjOSWgDHuRlv) | Miguel | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 44 | [Sativa](https://open.spotify.com/track/2pg2TiYo9Rb8KeB5JjP7jS) | Jhené Aiko, Swae Lee | Estimated words | Estimated words | lrclib | Accuracy pending |
| 45 | [Heartbreak Anniversary](https://open.spotify.com/track/3FAJ6O0NOHQV8Mc5Ri6ENp) | GIVĒON | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 46 | [Exchange](https://open.spotify.com/track/43PuMrRfbyyuz4QpZ3oAwN) | Bryson Tiller | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 47 | [oui](https://open.spotify.com/track/0PJIbOdMs3bd5AT8liULMQ) | Jeremih | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 48 | [ALL MINE](https://open.spotify.com/track/3XgGQ1wjo5khvq2UImjyNF) | Brent Faiyaz | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 49 | [Blessed](https://open.spotify.com/track/2XjoHA58XD0t3qye8bYGU8) | Daniel Caesar | Estimated words | Word timestamps | yrc | Accuracy pending |
| 50 | [The Weekend](https://open.spotify.com/track/6gU9OKjOE7ghfEd55oRO57) | SZA | Estimated words | Word timestamps | yrc | Accuracy pending |
| 51 | [Her Way](https://open.spotify.com/track/3JEJwjqLkg2Jbau5922CAb) | PARTYNEXTDOOR | Estimated words | Estimated words | lrc | Accuracy pending |
| 52 | [Like I Want You](https://open.spotify.com/track/6qBFSepqLCuh5tehehc1bd) | GIVĒON | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 53 | [Best Time](https://open.spotify.com/track/1zgHn1EqUyA0HqNYMdJ5ia) | Brent Faiyaz | Estimated words | Estimated words | lrc | Accuracy pending |
| 54 | [Essence (feat. Tems)](https://open.spotify.com/track/5FG7Tl93LdH117jEKYl3Cm) | Wizkid, Tems | Estimated words | Word timestamps | yrc | Accuracy pending |
| 55 | [Go Crazy](https://open.spotify.com/track/1IIKrJVP1C9N7iPtG6eOsK) | Chris Brown, Young Thug | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 56 | [Free Mind](https://open.spotify.com/track/2mzM4Y0Rnx2BDZqRnhQ5Q6) | Tems | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 57 | [Nights Like This (feat. Ty Dolla $ign)](https://open.spotify.com/track/6ZRuF2n1CQxyxxAAWsKJOy) | Kehlani, Ty Dolla $ign | Estimated words | Word timestamps | yrc | Accuracy pending |
| 58 | [Been Away](https://open.spotify.com/track/5PvVkf1Yuq3XyMqqjPiKPd) | Brent Faiyaz | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 59 | [N o C h i l l](https://open.spotify.com/track/1zhMHgotgZXkLCXpqNRnPK) | PARTYNEXTDOOR | Estimated words | Estimated words | lrc | Accuracy pending |
| 60 | [Trip](https://open.spotify.com/track/6CTWathupIiDs7U4InHnDA) | Ella Mai | Estimated words | Word timestamps | yrc | Accuracy pending |
| 61 | [Higher](https://open.spotify.com/track/2QdSb68BzZGMgCbsrFmSLc) | Tems | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 62 | [30 For 30 (with Kendrick Lamar)](https://open.spotify.com/track/3aSWXU6owkZeVhh94XxEWO) | SZA, Kendrick Lamar | Estimated words | Estimated words | lrc | Accuracy pending |
| 63 | [What It Is (Solo Version)](https://open.spotify.com/track/73RbfOTJIjHzi2pcVHjeHM) | Doechii | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 64 | [CUFF IT](https://open.spotify.com/track/1xzi1Jcr7mEi9K2RfzLOqS) | Beyoncé | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 65 | [Could've Been (feat. Bryson Tiller)](https://open.spotify.com/track/6oEVnWKgPqIEPc53OYDNqG) | H.E.R., Bryson Tiller | Estimated words | Word timestamps | yrc | Accuracy pending |
| 66 | [Trust](https://open.spotify.com/track/0oufSLnKQDoBFX5mgkDCgR) | Brent Faiyaz | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 67 | [Maria Maria (feat. The Product G&B)](https://open.spotify.com/track/3XKIUb7HzIF1Vu9usunMzc) | Santana, The Product G&B | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 68 | [The Worst](https://open.spotify.com/track/2wBCrtJS3E3TimRZ5MElTI) | Jhené Aiko | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 69 | [Playing Games (with Bryson Tiller) - Extended Version](https://open.spotify.com/track/2xyx0o4xNOLLjBSbOOdcbA) | Summer Walker, Bryson Tiller | Estimated words | Word timestamps | yrc | Accuracy pending |
| 70 | [Boo'd Up](https://open.spotify.com/track/4squZv12LD9M8ooJfoVgZS) | Ella Mai | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 71 | [Love Me JeJe](https://open.spotify.com/track/1eDI5oU04SLsXl0TfxfwYf) | Tems | Estimated words | Estimated words | lrc | Accuracy pending |
| 72 | [KU LO SA - A COLORS SHOW](https://open.spotify.com/track/2WigMwGJysIh9fRnSJvpjn) | Oxlade | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 73 | [While We're Young](https://open.spotify.com/track/4mL59LVbKgOpEACxraGYdr) | Jhené Aiko | Estimated words | Word timestamps | yrc | Accuracy pending |
| 74 | [Spread Thin](https://open.spotify.com/track/4MbzauKV2ydtZZjLsPcuTF) | Mariah the Scientist | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 75 | [When I See U](https://open.spotify.com/track/4iuNZTcvT9diFySSzVsnVS) | Fantasia | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 76 | [Me & U](https://open.spotify.com/track/4nFrcGM7MY1mpoQCC7Kefj) | Tems | Estimated words | Estimated words | lrc | Accuracy pending |
| 77 | [Collide (feat. Tyga)](https://open.spotify.com/track/22I3h5AOENlH4CqXJsEbFR) | Justine Skye, Tyga | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 78 | [No Love (with SZA)](https://open.spotify.com/track/08SB2OtZkaliju77WYEKxk) | Summer Walker, SZA | Estimated words | Word timestamps | yrc | Accuracy pending |
| 79 | [Good Days](https://open.spotify.com/track/3YJJjQPAbDT7mGpX3WtQ9A) | SZA | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 80 | [my mine](https://open.spotify.com/track/2B8Y5LaNSEkuB3LA9okArd) | Jhené Aiko | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 81 | [Adorn](https://open.spotify.com/track/25cUhiAod71TIQSNicOaW3) | Miguel | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 82 | [YES IT IS](https://open.spotify.com/track/2iksjpqL3eraxCBKqNHuqd) | Leon Thomas | Estimated words | Estimated words | lrc | Accuracy pending |
| 83 | [Body](https://open.spotify.com/track/7vxLj7MREliG5i5vSnqSVr) | Summer Walker | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 84 | [act ii: date @ 8 (feat. Drake) - remix](https://open.spotify.com/track/3QS9ZCtoSCJhmaJ7QNXSAS) | 4batz, Drake | Estimated words | Estimated words | lrc | Accuracy pending |
| 85 | [Gonna Love Me](https://open.spotify.com/track/3nXrCAE44KlevAkQB2XWcN) | Teyana Taylor | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 86 | [Pretty Little Fears (feat. J. Cole)](https://open.spotify.com/track/4at3d5QWnlibMVN75ECDrp) | 6LACK, J. Cole | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 87 | [Treasure In The Hills](https://open.spotify.com/track/64TJKMfx0QxpuR7rTXL05c) | Leon Thomas | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 88 | [Last Heartbreak Song (feat. Giveon)](https://open.spotify.com/track/1A1ifX8sWzelNpkL5PxcHT) | Ayra Starr, GIVĒON | Estimated words | Estimated words | lrc | Accuracy pending |
| 89 | [Karma](https://open.spotify.com/track/2Fyjjpg03fn7n5cj0Qm380) | Summer Walker | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 90 | [Easy - Remix](https://open.spotify.com/track/4CMrdHWqic0usIZfTrKoI3) | DaniLeigh, Chris Brown | Estimated words | Word timestamps | yrc | Accuracy pending |
| 91 | [living room flow - Bonus](https://open.spotify.com/track/4Li8dc3ucCesQJMKErU5zM) | Jhené Aiko | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 92 | [PERSIAN RUGS](https://open.spotify.com/track/2SWbnWSe1onmbllRAU46uo) | PARTYNEXTDOOR | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 93 | [All For Me](https://open.spotify.com/track/7vIDhgD7WWTMpvgJebImoN) | Mariah the Scientist | Estimated words | Estimated words | lrc | Accuracy pending |
| 94 | [The Beach](https://open.spotify.com/track/2Hd7uGbl8PX0IxyX59VFOg) | GIVĒON | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 95 | [back of the club](https://open.spotify.com/track/6svat6LhQXRAnALB7CkUg5) | kwn | Estimated words | Estimated words | lrc | Accuracy pending |
| 96 | [She Don't (feat. Ty Dolla $Ign)](https://open.spotify.com/track/01JPQ87UHeGysPVwTqMJHK) | Ella Mai, Ty Dolla $ign | Estimated words | Word timestamps | yrc | Accuracy pending |
| 97 | [Toxic](https://open.spotify.com/track/5nexAvWNhwg51EavnDgViy) | Kehlani | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 98 | [Always n Forever (feat. Lil Baby)](https://open.spotify.com/track/6dbENHQHHtWRai4snSvy2w) | Mariah the Scientist, Lil Baby | Estimated words | Word timestamps | yrc | Accuracy pending |
| 99 | [Garden Kisses](https://open.spotify.com/track/62d6YXEYxmMWAuLpw1EysL) | GIVĒON | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 100 | [Caught Up](https://open.spotify.com/track/5zdUc1JRCImBYcDWgvFNpE) | USHER | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 101 | [PRBLMS](https://open.spotify.com/track/4AtZRwSR8BOTTQg5ihSggt) | 6LACK | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 102 | [Unhinged](https://open.spotify.com/track/5hvyS23Ya468Sp4VeL48U5) | Masego | Estimated words | Estimated words | lrc | Accuracy pending |
| 103 | [ART](https://open.spotify.com/track/40ds3xedbMkWhszkGnZwxi) | Tyla | Estimated words | Estimated words | lrc | Accuracy pending |
| 104 | [ICU](https://open.spotify.com/track/3tpI98Yae25hSvhh6mitA9) | Coco Jones | Estimated words | Estimated words | lrc | Accuracy pending |
| 105 | [TYRANT](https://open.spotify.com/track/5mUlozUYpdmXVPkj4BW8cA) | Beyoncé, Dolly Parton | Estimated words | Estimated words | lrc | words beyond recording |
| 106 | [Self Righteous](https://open.spotify.com/track/4w9dTbEcJx8uBTxGvUYC0h) | Bryson Tiller | Estimated words | Estimated words | lrc | Accuracy pending |
| 107 | [This Is](https://open.spotify.com/track/2zuDMKJ2rSgCMtJknUJBZ9) | Ella Mai | Estimated words | Estimated words | lrc | Accuracy pending |
| 108 | [Focus](https://open.spotify.com/track/3tZs3nVjySLbL320lP4mvs) | H.E.R. | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 109 | [Medicine](https://open.spotify.com/track/4lFfMRH0YH4pW5gczTDbNC) | Queen Naija | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 110 | [Best Part (feat. H.E.R.)](https://open.spotify.com/track/4OBZT9EnhYIV17t4pGw7ig) | Daniel Caesar, H.E.R. | Estimated words | Word timestamps | yrc | Accuracy pending |
| 111 | [Cranes in the Sky](https://open.spotify.com/track/48EjSdYh8wz2gBxxqzrsLe) | Solange | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 112 | [NOT FAIR](https://open.spotify.com/track/277K8GOv27Pq3qS4IKSRoW) | Leon Thomas | Estimated words | Estimated words | lrc | Accuracy pending |
| 113 | [Over](https://open.spotify.com/track/23CKxEwKWsLs6LD5poGOLM) | Lucky Daye | Estimated words | Estimated words | lrc | Accuracy pending |
| 114 | [Every Kind Of Way](https://open.spotify.com/track/0Aa3g9EQoPNt6PiKjaUeb7) | H.E.R. | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 115 | [HEATED](https://open.spotify.com/track/1w7cgGZR86yWz1pA2puVJD) | Beyoncé | Estimated words | Word timestamps | yrc | Accuracy pending |
| 116 | [After Hours](https://open.spotify.com/track/2x03XLsTZ0o86h0cfHrkKF) | Kehlani | Estimated words | Estimated words | lrc | Accuracy pending |
| 117 | [IN YOUR EYES](https://open.spotify.com/track/1wjDFBUOMuZKm1eJ8GzRBX) | Snoh Aalegra | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 118 | [After Last Night (with Thundercat & Bootsy Collins)](https://open.spotify.com/track/6jGAh1bFnXt1Muj9zeHveZ) | Bruno Mars, Anderson .Paak, Silk Sonic, Thundercat, Bootsy Collins | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 119 | [On My Mama](https://open.spotify.com/track/7DswEZZthZ6piQpL25qGAM) | Victoria Monét | Estimated words | Word timestamps | yrc | Accuracy pending |
| 120 | [do what i say](https://open.spotify.com/track/5P8zrJH6NhD2QRIscTSTcq) | kwn | Estimated words | Estimated words | lrc | Accuracy pending |
| 121 | [Gangsta](https://open.spotify.com/track/5cw9s2zGrbny2M2p3WRmGm) | Kehlani | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 122 | [Say Yes](https://open.spotify.com/track/2fE4MbwX3QGMzNaMjGVhtw) | Floetry | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 123 | [VIBES DON'T LIE](https://open.spotify.com/track/1WwrfoGe0K33z1tVI6mevJ) | Leon Thomas | Estimated words | Estimated words | lrc | Accuracy pending |
| 124 | [I Want You Around](https://open.spotify.com/track/2gjidmxtA1pyj2HYrdOTG1) | Snoh Aalegra | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 125 | [Shea Butter Baby (with J. Cole)](https://open.spotify.com/track/5BOBHIBuzvQuIYL1E1nDzl) | Ari Lennox, J. Cole | Estimated words | Word timestamps | yrc | Accuracy pending |
| 126 | [2 Sugar (feat. Ayra Starr)](https://open.spotify.com/track/1DA2ADZs6O28y2rmdmpekw) | Wizkid, Ayra Starr | Estimated words | Estimated words | lrc | Accuracy pending |
| 127 | [Superstar](https://open.spotify.com/track/18JosZY3HzD3lMy6iOOSAY) | USHER | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 128 | [DFMU](https://open.spotify.com/track/1bdm32mVmoGcek5bVKxQKd) | Ella Mai | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 129 | [What You Did (feat. Ella Mai)](https://open.spotify.com/track/2B7UWqNqKgPVGQQ6FXn2PP) | Mahalia, Ella Mai | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 130 | [KEHLANI (REMIX) [feat. Kehlani]](https://open.spotify.com/track/5Nt2FMqnKI2mlp7lztURNo) | Jordan Adetunji, Kehlani | Estimated words | Estimated words | lrc | Accuracy pending |
| 131 | [22](https://open.spotify.com/track/1QxTmNDHFmgaxgAolqqgAD) | JayO | Estimated words | Estimated words | lrc | Accuracy pending |
| 132 | [BUTTERFLIES](https://open.spotify.com/track/4nNpY2RyMQMvlKkQMRb5XQ) | Isaiah Falls, Joyce Wrice | Estimated words | Estimated words | lrc | Accuracy pending |
| 133 | [CUT UP](https://open.spotify.com/track/68aYtH4NsGGp331mVDIVCC) | SAILORR | Estimated words | Estimated words | lrc | Accuracy pending |
| 134 | [EX](https://open.spotify.com/track/47cQCF21TczFSmGfpd7c07) | Kiana Ledé | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 135 | [True Love (feat. Tay Iwar & Projexx)](https://open.spotify.com/track/4204hwPYuToiuSunPFUoML) | Wizkid, Tay Iwar, Projexx | Estimated words | Word timestamps | yrc | Accuracy pending |
| 136 | [Alright](https://open.spotify.com/track/3OgdnA3LYpJ6vxrfk6X3p4) | Victoria Monét | Estimated words | Estimated words | lrc | Accuracy pending |
| 137 | [Jump](https://open.spotify.com/track/0ve0CavjqrUqVmZ605RhTV) | Tyla, Gunna, Skillibeng | Estimated words | Estimated words | lrc | Accuracy pending |
| 138 | [Issues/Hold On](https://open.spotify.com/track/0bxmVPKnEopTyuMMkaTvUb) | Teyana Taylor | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 139 | [FOREVER (with 6LACK)](https://open.spotify.com/track/2lVYLiHGIX6GajMqYXF1Un) | Jessie Reyez, 6LACK | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 140 | [Skin Tight (feat. Steve Lacy)](https://open.spotify.com/track/4KVSdwwJ67JHu5s9vIA0zi) | Ravyn Lenae, Steve Lacy | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 141 | [AMERICA HAS A PROBLEM (feat. Kendrick Lamar)](https://open.spotify.com/track/6l8mgVN9Xf1hiDIFGA6CTE) | Beyoncé, Kendrick Lamar | Estimated words | Estimated words | lrc | Accuracy pending |
| 142 | [Wild Side (feat. Cardi B)](https://open.spotify.com/track/2vXgyN14LX2zl7JEASw242) | Normani, Cardi B | Estimated words | Word timestamps | yrc | Accuracy pending |
| 143 | [Fly Girl (feat. Missy Elliott)](https://open.spotify.com/track/2sITbbWIOeg2Lwp4WN2jqr) | FLO, Missy Elliott | Estimated words | Estimated words | lrc | Accuracy pending |
| 144 | [Ciao!](https://open.spotify.com/track/0oMlowcYGs70fDAfRf8eKJ) | Bryson Tiller | Estimated words | Estimated words | lrc | Accuracy pending |
| 145 | [Come Through (feat. Chris Brown)](https://open.spotify.com/track/3krZxyBsWEHfEfJegYaWTd) | H.E.R., Chris Brown | Estimated words | Word timestamps | yrc | Accuracy pending |
| 146 | [PLASTIC OFF THE SOFA](https://open.spotify.com/track/6ufcuVInt0ocHrUimDjGlb) | Beyoncé | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 147 | [Binz](https://open.spotify.com/track/7yvdp8dqmxExSJwT2fn6Xq) | Solange | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 148 | [Superpowers](https://open.spotify.com/track/7KaM1Tz8Jsv6m2lUsmUy4z) | Muni Long | Estimated words | Estimated words | lrc | Accuracy pending |
| 149 | [Good & Plenty - Remix](https://open.spotify.com/track/6T3Ebo7EOh8cUOyE4OhFpp) | Lucky Daye, Masego, Alex Isley, Jack Dine | Word timestamps | Word timestamps | yrc | Accuracy pending |
| 150 | [GLOCK](https://open.spotify.com/track/29sbEEB0w4aAY3FofzzEjy) | Don Toliver | Estimated words | Estimated words | lrc | Accuracy pending |

## Repeating the audit

```sh
swift run --package-path scripts/tv-coverage --scratch-path /tmp/bar4bar-coverage-build TVCoverage docs/quality/gold-edition-tracks-2026-09-11.json /tmp/gold-edition-native.json
node scripts/check-tv-coverage.mjs docs/quality/gold-edition-tracks-2026-09-11.json /tmp/gold-edition-providers.json
node scripts/summarize-tv-coverage.mjs docs/quality/gold-edition-tracks-2026-09-11.json docs/quality/gold-edition-native-2026-09-11.json /tmp/gold-edition-native.json /tmp/gold-edition-report.md
```

The native report is authoritative for what the app selects. The provider audit is diagnostic: it checks payload availability rather than parsing or acoustic accuracy. An empty HTTP 200 response is not proof that the upstream provider is healthy.
