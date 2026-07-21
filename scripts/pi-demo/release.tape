Output .tmp/pi-demo/release-candidate/pi-demo.mp4

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 16
Set Width 1200
Set Height 800
Set Padding 18
Set TypingSpeed 32ms
Set WaitTimeout 90s
Set Theme "iTerm2 Dark Background"

Hide
Type "bun run scripts/pi-demo/launch.ts --prepared --release"
Enter
Sleep 4s
Show

Type "Please remember that I understand coding concepts best through cooking metaphors"
Enter
Wait+Screen /Cooking preference saved\./
Sleep 3s
Screenshot .tmp/pi-demo/release-candidate/pi-demo.png
Sleep 1s

Type "/new"
Sleep 1s
Enter
Wait+Screen /session preferences loaded automatically/
Sleep 5s

Type "Please explain how macros in rust work"
Enter
Wait+Screen /recurring code patterns/
Sleep 3s
Screenshot .tmp/pi-demo/release-candidate/pi-demo-explanation.png
Sleep 1s

Type "/new"
Sleep 1s
Enter
Wait+Screen /session preferences loaded automatically/
Sleep 2s

Type "Whats the status of the knowledge base?"
Enter
Wait+Screen /links healthy/
Sleep 3s
Screenshot .tmp/pi-demo/release-candidate/pi-demo-health.png
Sleep 1s

Type "/new"
Sleep 1s
Enter
Wait+Screen /2 session preferences loaded automatically/
Sleep 2s

Type "I was joking about the cooking metaphors. Please remove that preference."
Enter
Wait+Screen /Cooking-metaphor preference removed\./
Sleep 2s
Screenshot .tmp/pi-demo/release-candidate/pi-demo-cleanup.png
Sleep 1s

Hide
Type "/quit"
Enter
Sleep 500ms
