function Initialize-QQPetInstalledState {
  param([Parameter(Mandatory=$true)][string]$ClientRoot,[switch]$CheckOnly)
  $client=[IO.Path]::GetFullPath($ClientRoot)
  $catalogFile=[IO.Path]::Combine($client,'config','installed-startup.json')
  if(([IO.File]::GetAttributes($client) -band [IO.FileAttributes]::ReparsePoint) -or ([IO.File]::GetAttributes($catalogFile) -band [IO.FileAttributes]::ReparsePoint)){throw 'STARTUP_STATE_LINK_REFUSED'}
  $catalog=[IO.File]::ReadAllText($catalogFile) | ConvertFrom-Json
  if($catalog.kind -cne 'qqpet-installed-startup' -or $catalog.schemaVersion -ne 1 -or [string]$catalog.rootVersion -cnotmatch '^[1-9][0-9]{0,4}$' -or $catalog.rootVersion -gt 65535 -or -not $catalog.resources.Count){throw 'STARTUP_STATE_CATALOG_INVALID'}
  $resources=New-Object 'Collections.Generic.Dictionary[string,uint32]' ([StringComparer]::OrdinalIgnoreCase)
  foreach($item in $catalog.resources){
    if($item.path -cnotmatch '^[A-Za-z0-9_.\/-]+$' -or $item.path -match '(^|/)(\.|\.\.|)(/|$)' -or [string]$item.version -cnotmatch '^(0|[1-9][0-9]{0,8})$' -or $resources.ContainsKey($item.path)){throw 'STARTUP_STATE_CATALOG_INVALID'}
    $resources.Add($item.path,[uint32]$item.version)
  }
  $settings=New-Object Xml.XmlReaderSettings
  $settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver=$null
  $reader=[Xml.XmlReader]::Create([IO.Path]::Combine($client,('Plugin'+$catalog.rootVersion+'.xml')),$settings)
  $document=New-Object Xml.XmlDocument
  $document.XmlResolver=$null
  try {$document.Load($reader)} finally {$reader.Dispose()}
  if($document.DocumentElement.Name -cne 'PluginXML' -or $document.DocumentElement.GetAttribute('Version') -cne [string]$catalog.rootVersion){throw 'STARTUP_STATE_PLUGIN_MISMATCH'}
  $expected=New-Object 'Collections.Generic.Dictionary[string,uint32]' ([StringComparer]::OrdinalIgnoreCase)
  foreach($item in $document.SelectNodes('//Item[@FILE and @Version]')){
    $name=$item.GetAttribute('FILE')
    $version=$item.GetAttribute('Version')
    if($version -cnotmatch '^(0|[1-9][0-9]{0,8})$'){throw 'STARTUP_STATE_PLUGIN_MISMATCH'}
    if($expected.ContainsKey($name)){
      if($expected[$name] -ne [uint32]$version){throw 'STARTUP_STATE_PLUGIN_MISMATCH'}
    } else {$expected.Add($name,[uint32]$version)}
  }
  $removed=New-Object 'Collections.Generic.Dictionary[string,uint32]' ([StringComparer]::OrdinalIgnoreCase)
  $layoutFile=[IO.Path]::Combine($client,'client-root-layout.json')
  if([IO.File]::Exists($layoutFile)){
    if([IO.File]::GetAttributes($layoutFile) -band [IO.FileAttributes]::ReparsePoint){throw 'STARTUP_STATE_LINK_REFUSED'}
    $layout=[IO.File]::ReadAllText($layoutFile) | ConvertFrom-Json
    if($layout.kind -cne 'qqpet-client-root-layout' -or $layout.schemaVersion -ne 1 -or $layout.rootVersion -ne $catalog.rootVersion){throw 'STARTUP_STATE_LAYOUT_INVALID'}
    $omitted=New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
    foreach($archive in $layout.omittedArchives){
      if($archive.path -cnotmatch '^[A-Za-z0-9_.-]+\.zip$' -or $omitted.ContainsKey($archive.path) -or [IO.File]::Exists([IO.Path]::Combine($client,$archive.path)) -or -not $archive.witnesses.Count){throw 'STARTUP_STATE_LAYOUT_INVALID'}
      $omitted.Add($archive.path,$archive)
    }
    foreach($item in $layout.removedPluginItems){
      if(-not $omitted.ContainsKey($item.path) -or -not $omitted[$item.path].registrationRemoved -or $removed.ContainsKey($item.path) -or -not $resources.ContainsKey($item.path) -or $resources[$item.path] -ne $item.version -or $expected.ContainsKey($item.path)){throw 'STARTUP_STATE_LAYOUT_INVALID'}
      foreach($witness in $omitted[$item.path].witnesses){
        if($witness.path -cnotmatch '^[A-Za-z0-9_.-]+\.dll$' -or $witness.member -cne $witness.path -or $witness.sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'STARTUP_STATE_LAYOUT_INVALID'}
        $file=[IO.Path]::Combine($client,$witness.path)
        if([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint){throw 'STARTUP_STATE_LINK_REFUSED'}
        $stream=[IO.File]::OpenRead($file);$digest=[Security.Cryptography.SHA256]::Create()
        try {$hash=[BitConverter]::ToString($digest.ComputeHash($stream)).Replace('-','').ToLowerInvariant();$size=$stream.Length} finally {$stream.Dispose();$digest.Dispose()}
        if($hash -cne $witness.sha256 -or $size -ne $witness.size){throw 'STARTUP_STATE_LAYOUT_WITNESS_CHANGED'}
      }
      $removed.Add($item.path,[uint32]$item.version)
    }
    if(@($layout.omittedArchives | Where-Object {$_.registrationRemoved}).Count -ne $removed.Count){throw 'STARTUP_STATE_LAYOUT_INVALID'}
  }
  if($expected.Count+$removed.Count -ne $resources.Count){throw 'STARTUP_STATE_PLUGIN_MISMATCH'}
  foreach($name in $expected.Keys){
    if(-not $resources.ContainsKey($name) -or $resources[$name] -ne $expected[$name]){throw 'STARTUP_STATE_PLUGIN_MISMATCH'}
  }
  $versions=New-Object Text.StringBuilder
  foreach($item in $catalog.resources){if($expected.ContainsKey($item.path)){[void]$versions.Append('['+$item.path+"]`r`nVersion="+$item.version+"`r`n`r`n")}}
  $contents=@{
    'pluginversion.ini'="[localpluginversion]`r`nversion="+$catalog.rootVersion+"`r`n"
    'LocalVersion.ini'=$versions.ToString()
  }
  $created=0
  foreach($name in @('pluginversion.ini','LocalVersion.ini')){
    $target=[IO.Path]::Combine($client,$name)
    if([IO.File]::Exists($target)){
      if([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::ReparsePoint){throw 'STARTUP_STATE_LINK_REFUSED'}
      continue # Existing client-maintained state is never read or overwritten.
    }
    if([IO.Directory]::Exists($target)){throw 'STARTUP_STATE_PATH_INVALID'}
    if($CheckOnly){continue}
    $temporary=$target+'.create-'+[Guid]::NewGuid().ToString('N')
    try {
      $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try {
        $body=[Text.Encoding]::ASCII.GetBytes($contents[$name])
        $stream.Write($body,0,$body.Length);$stream.Flush($true)
      } finally {$stream.Dispose()}
      try {[IO.File]::Move($temporary,$target);$created++} catch {if(-not [IO.File]::Exists($target)){throw}}
    } finally {if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}
  }
  [pscustomobject]@{RootVersion=$catalog.rootVersion;ResourceVersions=$resources.Count;Created=$created;CheckOnly=[bool]$CheckOnly}
}
