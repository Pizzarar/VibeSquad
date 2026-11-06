' Windowless launcher: starts server\serve.mjs in the background (it boots the VS runner with --background).
' Paseo is NOT started here: serve.mjs starts it itself only when Settings > startPaseoWithVibeSquad is on.
' Pass --open to also open the browser. serve.mjs exits 0 on its own if the port is already taken.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
extra = " --background"
For Each a In WScript.Arguments
  If a = "--open" Then extra = extra & " --open"
Next
nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If fso.FileExists(nodeExe) Then
  nodeCmd = """" & nodeExe & """"
Else
  nodeCmd = "node.exe"
End If
sh.Run nodeCmd & " """ & root & "\server\serve.mjs""" & extra, 0, False
