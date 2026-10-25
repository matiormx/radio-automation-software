# Compila ffmpeg-ndi.exe para Windows.
#
# Requisitos:
#   - Git para Windows.
#   - MSYS2 en C:\msys64 (o indicar -Msys2Root).
#   - NDI Runtime o NDI SDK. Si no se encuentra el SDK, el script descarga
#     e instala el NDI Runtime y usa las cabeceras MIT de DistroAV.
#
# El resultado queda en src-tauri\bin\ffmpeg-ndi.exe y Tauri lo incluye en el
# instalador porque bundle.resources recoge src-tauri\bin\*.

[CmdletBinding()]
param(
    [string]$NdiSdkDir = "",
    [string]$Msys2Root = "C:\msys64",
    [string]$BuildDir = "",
    [string]$OutDir = "",
    [switch]$SkipDeps,
    [switch]$NoRuntimeCopy
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
if (-not $BuildDir) { $BuildDir = Join-Path $Msys2Root "tmp\miradio-ffmpeg-ndi" }
if (-not $OutDir) { $OutDir = Join-Path $Root "src-tauri\bin" }

$Bash = Join-Path $Msys2Root "usr\bin\bash.exe"
if (-not (Test-Path -LiteralPath $Bash)) {
    throw "No se encontró MSYS2 en '$Msys2Root'. Instálalo desde https://www.msys2.org/ o indica -Msys2Root."
}
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Quote-Bash([string]$Value) {
    return "'" + $Value.Replace("'", "'\''") + "'"
}

function To-MsysPath([string]$Path) {
    $result = & $Bash -lc "cygpath -u $(Quote-Bash $Path)"
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo convertir la ruta '$Path' a formato MSYS2."
    }
    return ($result | Select-Object -Last 1).Trim()
}

function Find-NdiSdk([string]$ExplicitDir) {
    $candidates = @()
    if ($ExplicitDir) { $candidates += $ExplicitDir }
    if ($env:NDI_SDK_DIR) { $candidates += $env:NDI_SDK_DIR }
    $programFiles = [Environment]::GetFolderPath("ProgramFiles")
    $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
    $candidates += @(
        (Join-Path $programFiles "NDI\NDI 6 SDK"),
        (Join-Path $programFiles "NDI\NDI 5 SDK"),
        (Join-Path $programFiles "NewTek\NewTek NDI SDK"),
        (Join-Path $programFiles "NewTek\NewTek NDI 5 SDK"),
        (Join-Path $programFilesX86 "NDI\NDI 6 SDK"),
        (Join-Path $programFilesX86 "NDI\NDI 5 SDK")
    )

    foreach ($dir in $candidates) {
        if (-not $dir) { continue }
        $include = Join-Path $dir "Include"
        if (-not (Test-Path -LiteralPath (Join-Path $include "Processing.NDI.Lib.h"))) {
            $include = Join-Path $dir "include"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $include "Processing.NDI.Lib.h"))) {
            continue
        }

        $dll = Join-Path $dir "Bin\x64\Processing.NDI.Lib.x64.dll"
        if (-not (Test-Path -LiteralPath $dll)) {
            $dll = Join-Path $dir "bin\x64\Processing.NDI.Lib.x64.dll"
        }
        if (-not (Test-Path -LiteralPath $dll)) { $dll = $null }

        return [pscustomobject]@{
            Include = $include
            Dll     = $dll
            Source  = $dir
        }
    }
    return $null
}

function Install-NdiRuntime {
    $runtimeDirs = @()
    foreach ($var in @("NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5")) {
        if ([Environment]::GetEnvironmentVariable($var)) {
            $runtimeDirs += [Environment]::GetEnvironmentVariable($var)
        }
    }
    $programFiles = [Environment]::GetFolderPath("ProgramFiles")
    $runtimeDirs += @(
        (Join-Path $programFiles "NDI\NDI 6 Runtime"),
        (Join-Path $programFiles "NDI\NDI 5 Runtime"),
        (Join-Path $programFiles "NewTek\NewTek NDI 6 Runtime"),
        (Join-Path $programFiles "NewTek\NewTek NDI 5 Runtime")
    )

    foreach ($dir in $runtimeDirs) {
        if (-not $dir) { continue }
        $dll = Join-Path $dir "Processing.NDI.Lib.x64.dll"
        if (Test-Path -LiteralPath $dll) { return $dll }
    }

    $installer = Join-Path $BuildDir "NDI6Runtime.exe"
    if (-not (Test-Path -LiteralPath $installer)) {
        Write-Host "==> Descargando NDI Runtime"
        Invoke-WebRequest -UseBasicParsing -UserAgent "Mozilla/5.0" -Uri "https://downloads.ndi.tv/SDK/NDI_SDK/NDI%206%20Runtime.exe" -OutFile $installer
    }

    Write-Host "==> Instalando NDI Runtime en modo silencioso"
    try {
        $process = Start-Process -FilePath $installer -ArgumentList "/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES" -Wait -PassThru
    } catch {
        throw "No se pudo instalar el NDI Runtime. Instálalo manualmente desde https://ndi.video/tools/ o indica -NdiSdkDir con el SDK."
    }
    if ($process.ExitCode -notin @(0, 1641, 3010)) {
        throw "El instalador del NDI Runtime terminó con código $($process.ExitCode). Instálalo manualmente o indica -NdiSdkDir."
    }

    foreach ($dir in $runtimeDirs) {
        if (-not $dir) { continue }
        $dll = Join-Path $dir "Processing.NDI.Lib.x64.dll"
        if (Test-Path -LiteralPath $dll) { return $dll }
    }

    throw "Se instaló el NDI Runtime pero no se encontró Processing.NDI.Lib.x64.dll. Indica -NdiSdkDir."
}

function Get-NdiHeaders([string]$Destination) {
    $headers = @(
        "Processing.NDI.Lib.h",
        "Processing.NDI.compat.h",
        "Processing.NDI.structs.h",
        "Processing.NDI.deprecated.h",
        "Processing.NDI.Find.h",
        "Processing.NDI.Recv.h",
        "Processing.NDI.Send.h",
        "Processing.NDI.utilities.h",
        "Processing.NDI.DynamicLoad.h",
        "Processing.NDI.FrameSync.h",
        "Processing.NDI.Lib.cplusplus.h",
        "Processing.NDI.Recv.ex.h",
        "Processing.NDI.RecvAdvertiser.h",
        "Processing.NDI.RecvListener.h",
        "Processing.NDI.Routing.h",
        "Processing.NDI.SendAdvertiser.h",
        "Processing.NDI.SendListener.h"
    )

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($name in $headers) {
        $target = Join-Path $Destination $name
        if (Test-Path -LiteralPath $target) { continue }
        $url = "https://raw.githubusercontent.com/DistroAV/DistroAV/master/lib/ndi/$name"
        Write-Host "==> Descargando cabecera NDI $name"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $target
    }
    return $Destination
}

function New-NdiImportLib([string]$DllPath, [string]$LibDir) {
    New-Item -ItemType Directory -Force -Path $LibDir | Out-Null
    $dllMsys = To-MsysPath $DllPath
    $libMsys = To-MsysPath $LibDir
    $command = "export PATH=/mingw64/bin:`$PATH; cd $(Quote-Bash $libMsys) && gendef $(Quote-Bash $dllMsys) >/dev/null && dlltool -d Processing.NDI.Lib.x64.def -l libndi.a -D Processing.NDI.Lib.x64.dll"
    & $Bash -lc $command
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo generar libndi.a a partir de '$DllPath'."
    }
}

function Install-MsysDependencies {
    if ($SkipDeps) { return }
    Write-Host "==> Instalando dependencias de MSYS2 (gcc, make, nasm, x264, OpenSSL...)"
    & $Bash -lc "pacman -S --noconfirm --needed git make mingw-w64-x86_64-gcc mingw-w64-x86_64-nasm mingw-w64-x86_64-yasm mingw-w64-x86_64-pkg-config mingw-w64-x86_64-x264 mingw-w64-x86_64-openssl mingw-w64-x86_64-zlib mingw-w64-x86_64-tools"
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudieron instalar las dependencias de MSYS2. Abre MSYS2 como administrador o usa -SkipDeps."
    }
}

Install-MsysDependencies

$ndiSdk = Find-NdiSdk $NdiSdkDir
if ($ndiSdk) {
    Write-Host "==> NDI SDK: $($ndiSdk.Source)"
    $ndiInclude = $ndiSdk.Include
    $ndiDll = $ndiSdk.Dll
    if (-not $ndiDll) {
        $ndiDll = Install-NdiRuntime
    }
} else {
    Write-Host "==> No se encontró el NDI SDK; usando NDI Runtime y cabeceras MIT"
    $ndiDll = Install-NdiRuntime
    $ndiInclude = Get-NdiHeaders (Join-Path $BuildDir "ndi-include")
}

# FFmpeg configure separa --extra-cflags por espacios, así que las cabeceras
# deben estar en una ruta sin espacios (C:\msys64\tmp\...).
$stagedInclude = Join-Path $BuildDir "ndi-include"
if (-not [string]::Equals($ndiInclude, $stagedInclude, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "==> Copiando cabeceras NDI a $stagedInclude"
    New-Item -ItemType Directory -Force -Path $stagedInclude | Out-Null
    Copy-Item -Path (Join-Path $ndiInclude "*") -Destination $stagedInclude -Recurse -Force
    $ndiInclude = $stagedInclude
}

$ndiLib = Join-Path $BuildDir "ndi-lib"
New-NdiImportLib $ndiDll $ndiLib

$env:BUILD_DIR = To-MsysPath $BuildDir
$env:OUT_DIR = To-MsysPath $OutDir
$env:NDI_INCLUDE = To-MsysPath $ndiInclude
$env:NDI_LIB = To-MsysPath $ndiLib
$env:JOBS = [string][Environment]::ProcessorCount
$env:WITH_X264 = "1"
$env:WITH_TLS = "1"

$rootMsys = To-MsysPath $Root
$scriptMsys = To-MsysPath (Join-Path $Root "scripts\build-ffmpeg-ndi.sh")
$command = "export PATH=/mingw64/bin:`$PATH; cd $(Quote-Bash $rootMsys) && bash $(Quote-Bash $scriptMsys)"
& $Bash -lc $command
if ($LASTEXITCODE -ne 0) {
    throw "La compilación de FFmpeg con NDI falló."
}

$ffmpeg = Join-Path $OutDir "ffmpeg-ndi.exe"
if (-not (Test-Path -LiteralPath $ffmpeg)) {
    throw "La compilación terminó pero no se encontró '$ffmpeg'."
}

if (-not $NoRuntimeCopy -and $ndiDll -and (Test-Path -LiteralPath $ndiDll)) {
    Write-Host "==> Copiando Processing.NDI.Lib.x64.dll"
    Copy-Item -LiteralPath $ndiDll -Destination (Join-Path $OutDir "Processing.NDI.Lib.x64.dll") -Force
}

# Copia las DLL de MinGW que necesite ffmpeg-ndi.exe (x264, winpthread...).
$ffmpegMsys = To-MsysPath $ffmpeg
$deps = & $Bash -lc "ldd $(Quote-Bash $ffmpegMsys) 2>/dev/null | awk '/\/mingw64\/bin\// {print `$3}'"
foreach ($dep in $deps) {
    $dep = $dep.Trim()
    if (-not $dep) { continue }
    $winPath = (& $Bash -lc "cygpath -w $(Quote-Bash $dep)").Trim()
    if (Test-Path -LiteralPath $winPath) {
        Copy-Item -LiteralPath $winPath -Destination $OutDir -Force
    }
}

Write-Host "==> Comprobando que FFmpeg lista libndi_newtek"
$env:PATH = "$OutDir;$env:PATH"
$devices = & $ffmpeg -hide_banner -devices 2>&1
if (($devices | Out-String) -notmatch "libndi_newtek") {
    throw "FFmpeg se compiló pero no lista libndi_newtek. Revisa que el NDI Runtime esté instalado.`n$($devices | Out-String)"
}

Write-Host ""
Write-Host "Listo: $ffmpeg"
Write-Host "Tauri incluirá src-tauri\bin\* en el instalador."
Write-Host "Aviso: FFmpeg con NDI se compila con --enable-nonfree; revisa las licencias antes de distribuir el instalador."
