' Windowless launcher: starts Paseo daemon headless (paseo start), then server\serve.mjs in the background.
' Pass --open to also open the browser. serve.mjs exits 0 on its own if the port is already taken.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
paseoCandidates = Array( _
  sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\paseo.cmd", _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Paseo\resources\bin\paseo.cmd", _
  sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.vibesquad\paseo\paseo.cmd" _
)
paseoCmd = ""
For Each c In paseoCandidates
  If fso.FileExists(c) Then
    paseoCmd = c
    Exit For
  End If
Next
If paseoCmd <> "" Then
  sh.Run "cmd.exe /c """"" & paseoCmd & """ start""", 0, True
End If
extra = ""
For Each a In WScript.Arguments
  If a = "--open" Then extra = " --open"
Next
nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If fso.FileExists(nodeExe) Then
  nodeCmd = """" & nodeExe & """"
Else
  nodeCmd = "node.exe"
End If
sh.Run nodeCmd & " """ & root & "\server\serve.mjs""" & extra, 0, False
