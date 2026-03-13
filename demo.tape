Output assets/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1000
Set Height 800
Set Padding 20
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"

# Alias bunx to local build
Hide
Type "shopt -s expand_aliases && alias bunx='bun dist/setup.js #'"
Enter
Sleep 200ms
Type "clear"
Enter
Sleep 300ms
Show

# Part 1: Real interactive install for OpenCode
Type "bunx open-zk-kb"
Sleep 300ms
Enter
Sleep 4s

# Select OpenCode (1st item — already highlighted)
Space
Sleep 300ms
Enter
Sleep 3s

# Clear after install, then run demo
Hide
Type "clear"
Enter
Sleep 300ms
Type "bun scripts/demo-mcp.ts"
Enter
Sleep 500ms
Show
Sleep 35s
