' Starts serve-stockai.cmd with no visible window.
Set sh = CreateObject("WScript.Shell")
sh.Run """" & sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\stock\serve-stockai.cmd""", 0, False
