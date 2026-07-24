// The native macOS menu bar.
//
// Before this existed the app called autoHideMenuBar and never installed a menu
// at all — no ⌘, Preferences, no About, no Window menu. That's an instant App
// Store rejection and, more practically, it's why the app read as a web page in
// a frame: on macOS the menu bar IS a large part of "this is an application".
//
// Every item here sends an action name to the renderer, which routes it through
// the SAME handler a click would hit (see the onMenu switch in app/app.js).
// Nothing is implemented twice.

const { app, Menu, shell } = require('electron');

const isMac = process.platform === 'darwin';

/**
 * @param {{ send: (action: string) => void, openProjector: () => void }} handlers
 * @returns {Electron.Menu}
 */
function buildMenu({ send }) {
  const to = (action) => () => send(action);

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: `About ${app.name}` },
              { type: 'separator' },
              // ⌘, is where every Mac user looks for preferences.
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: to('settings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: `Hide ${app.name}` },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: `Quit ${app.name}` },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Search Songs…', accelerator: 'CmdOrCtrl+F', click: to('search') },
        { type: 'separator' },
        { label: 'Open Audio File…', accelerator: 'CmdOrCtrl+O', click: to('open-audio') },
        { label: 'Import Lyrics…', accelerator: 'CmdOrCtrl+Shift+O', click: to('open-lyrics') },
        { type: 'separator' },
        { label: 'Change Song', accelerator: 'CmdOrCtrl+L', click: to('change-song') },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'close' }]
          : [
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: to('settings') },
              { type: 'separator' },
              { role: 'quit' },
            ]),
      ],
    },
    {
      // Present so the search fields get the standard editing behaviour
      // (including ⌘A / ⌘Z, which don't work without a menu entry to own them).
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+1', click: to('home') },
        { label: 'Library', accelerator: 'CmdOrCtrl+2', click: to('library') },
        { label: 'Sources', accelerator: 'CmdOrCtrl+3', click: to('sources') },
        { type: 'separator' },
        { label: 'Focus Mode', accelerator: 'CmdOrCtrl+Shift+F', click: to('focus-mode') },
        { label: 'Reading Mode', accelerator: 'CmdOrCtrl+Shift+R', click: to('reading-mode') },
        { label: 'Pronunciation / Translation', accelerator: 'CmdOrCtrl+T', click: to('language-aid') },
        { type: 'separator' },
        { label: 'Projector Window…', click: to('projector') },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Playback',
      submenu: [
        // Deliberately NO accelerator. A bare `Space` accelerator is captured by
        // the menu before the renderer sees it, so it would swallow every space
        // typed into the search field. The renderer already binds Space and
        // guards on focus; the menu item is here for discoverability only.
        { label: 'Play / Pause', click: to('play-pause') },
        { type: 'separator' },
        { label: 'Lyrics Earlier', accelerator: 'CmdOrCtrl+]', click: to('nudge-earlier') },
        { label: 'Lyrics Later', accelerator: 'CmdOrCtrl+[', click: to('nudge-later') },
        { label: 'Reset Timing', accelerator: 'CmdOrCtrl+0', click: to('reset-timing') },
        { type: 'separator' },
        { label: 'Lyrics Feel Early', click: to('feel-early') },
        { label: 'Lyrics Feel Late', click: to('feel-late') },
      ],
    },
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: to('keys') },
        {
          label: 'Bar4Bar on GitHub',
          click: () => shell.openExternal('https://github.com/'),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
