Output .tmp/pi-demo/release-candidate/pi-demo.mp4

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 800
Set Padding 18
Set TypingSpeed 32ms
Set WaitTimeout 90s
Set Theme "Catppuccin Mocha"

Hide
Type "bun run scripts/pi-demo/launch.ts --prepared --release"
Enter
Sleep 7s
Show

Type "Please remember that I understand coding concepts best through cooking metaphors"
Enter
Wait+Screen /Preference response complete\./
Sleep 2s

Type "/new"
Enter
Sleep 2s

Type "Please explain how macros in rust work"
Enter
Wait+Screen /Rust response complete\./
Sleep 3s

Type "Whats the status of the knowledge base?"
Enter
Wait+Screen /Health response complete\./
Sleep 4s

Type "/quit"
Enter
Sleep 2s
