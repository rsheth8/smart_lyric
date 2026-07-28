# Bar4BarTV

Native Apple TV app. Generate the Xcode project:

```sh
xcodegen generate
open Bar4BarTV.xcodeproj
```

Package tests (no tvOS SDK required):

```sh
cd Bar4BarCore && swift test
```

Full setup: [../docs/tvos-migration.md](../docs/tvos-migration.md)
