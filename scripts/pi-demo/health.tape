Output .tmp/pi-demo-health/pi-demo-health.mp4

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
Type "bun run scripts/pi-demo/launch.ts --prepared --canonical"
Enter
Wait+Screen /2 session preferences loaded automatically/
Show
Sleep 2s

Type "Whats the status of the knowledge base?"
Enter
Wait+Screen /links healthy/
Sleep 3s
Screenshot .tmp/pi-demo/pi-demo-technical-health.png
Sleep 1s

Hide
Type "/quit"
Enter
Sleep 500ms
