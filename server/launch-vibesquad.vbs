' Windowless launcher: starts Paseo daemon headless (paseo start), then server\serve.mjs in the background.
' Pass --open to also open the browser. serve.mjs exits 0 on its own if the port is already taken.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
paseoCmd = sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\paseo.cmd"
If fso.FileExists(paseoCmd) Then
  sh.Run "cmd.exe /c """"" & sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\paseo.cmd"" start""", 0, True
End If
extra = ""
For Each a In WScript.Arguments
  If a = "--open" Then extra = " --open"
Next
sh.Run "node.exe """ & root & "\server\serve.mjs""" & extra, 0, False
