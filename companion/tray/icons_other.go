//go:build !windows
package tray

import _ "embed"

//go:embed icon_connected.png
var iconConnected []byte

//go:embed icon_disconnected.png
var iconDisconnected []byte
