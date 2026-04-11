Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d C:\Users\Keela\Desktop\claude-dashboard && node server.js", 0, False
WshShell.Run "cmd /c cd /d C:\Users\Keela\Desktop\claude-dashboard && node token-watcher.js", 0, False
WshShell.Run "cmd /c cd /d C:\Users\Keela\Desktop\claude-dashboard && node session-loop.js", 0, False
WshShell.Run "cmd /c cd /d C:\Users\Keela\Desktop\claude-dashboard && node usage-scraper.js", 0, False
