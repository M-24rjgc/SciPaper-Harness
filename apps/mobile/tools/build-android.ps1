param(
    [Parameter(Mandatory=$true)][string]$JdkHome,
    [string]$ToolsDirectory = (Join-Path $env:TEMP 'scipaper-mobile-toolchain'),
    [string]$SigningStore,
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$taskMobileRoot = Split-Path $PSScriptRoot -Parent
$taskBuildRoot = Join-Path $env:TEMP ('scipaper-mobile-build\' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $ToolsDirectory,$taskBuildRoot -Force | Out-Null
# The standalone Windows AAPT2 binary cannot resolve non-ASCII source paths.
$taskAndroidRoot = Join-Path $taskBuildRoot 'android'
Copy-Item -LiteralPath (Join-Path $taskMobileRoot 'android') -Destination $taskAndroidRoot -Recurse
$taskDependencies = @(
    @{ name='android-all.jar'; url='https://repo.maven.apache.org/maven2/org/robolectric/android-all/15-robolectric-12650502/android-all-15-robolectric-12650502.jar'; sha256='6C0670454F6FCEE9F1B17AA393E81D71BF26E7E6AE7C5777ED3924B062191D5B' },
    @{ name='aapt2.jar'; url='https://dl.google.com/dl/android/maven2/com/android/tools/build/aapt2/8.7.3-12006047/aapt2-8.7.3-12006047-windows.jar'; sha256='9406AF8E4742DA01E4CE65773E23BDA40ED5F599917B38CACC261C9BA0952331' },
    @{ name='r8.jar'; url='https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.7.18/r8-8.7.18.jar'; sha256='58366F77067207C39A17D469DE7B05701D2877212A9C55201BCB0AF43E59E903' },
    @{ name='apksig.jar'; url='https://dl.google.com/dl/android/maven2/com/android/tools/build/apksig/8.7.3/apksig-8.7.3.jar'; sha256='C070ED1394629D74641AA0906F60B2FFA1EE77E6366A1F93437F59717B1AEB89' },
    @{ name='zipflinger.jar'; url='https://dl.google.com/dl/android/maven2/com/android/zipflinger/8.7.3/zipflinger-8.7.3.jar'; sha256='81DD485618A509A3235929B9EB13091D884452661DE6CE5A45CC38B1C555421C' }
)
foreach($taskDependency in $taskDependencies) {
    $taskFile = Join-Path $ToolsDirectory $taskDependency.name
    if (!(Test-Path -LiteralPath $taskFile)) {
        & curl.exe --silent --show-error --fail --location --retry 4 $taskDependency.url --output $taskFile
        if ($LASTEXITCODE -ne 0) { throw ('Download failed: ' + $taskDependency.name) }
    }
    if ((Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash -ne $taskDependency.sha256) {
        throw ('Dependency checksum mismatch: ' + $taskDependency.name)
    }
}
$taskJava = Join-Path $JdkHome 'bin\java.exe'
$taskJavac = Join-Path $JdkHome 'bin\javac.exe'
$taskJar = Join-Path $JdkHome 'bin\jar.exe'
$taskAaptRoot = Join-Path $ToolsDirectory 'aapt2'
Copy-Item -LiteralPath (Join-Path $ToolsDirectory 'aapt2.jar') -Destination (Join-Path $ToolsDirectory 'aapt2.zip')
Expand-Archive -LiteralPath (Join-Path $ToolsDirectory 'aapt2.zip') -DestinationPath $taskAaptRoot -Force
$taskAapt = Join-Path $taskAaptRoot 'aapt2.exe'
$taskApi = Join-Path $ToolsDirectory 'android-all.jar'
$taskGenerated = Join-Path $taskBuildRoot 'generated'
$taskClasses = Join-Path $taskBuildRoot 'classes'
$taskDex = Join-Path $taskBuildRoot 'dex'
$taskToolsClasses = Join-Path $taskBuildRoot 'tools'
$taskTestClasses = Join-Path $taskBuildRoot 'tests'
New-Item -ItemType Directory -Path $taskGenerated,$taskClasses,$taskDex,$taskToolsClasses,$taskTestClasses -Force | Out-Null
$taskResources = Join-Path $taskBuildRoot 'resources.zip'
& $taskAapt compile --dir (Join-Path $taskAndroidRoot 'app\src\main\res') -o $taskResources
if ($LASTEXITCODE -ne 0) { throw 'Resource compilation failed' }
$taskResourceApk = Join-Path $taskBuildRoot 'resources.apk'
$taskManifest = Join-Path $taskAndroidRoot 'app\src\main\AndroidManifest.xml'
[xml]$taskManifestXml = Get-Content -LiteralPath $taskManifest -Raw
$taskManifestXml.manifest.SetAttribute('package','org.scipaper.mobile')
$taskManifestXml.Save($taskManifest)
& $taskAapt link -o $taskResourceApk -I $taskApi --manifest $taskManifest --java $taskGenerated $taskResources
if ($LASTEXITCODE -ne 0) { throw 'Resource linking failed' }
$taskSources = @(& rg --files (Join-Path $taskAndroidRoot 'app\src\main\java') $taskGenerated -g '*.java')
& $taskJavac --release 17 -encoding UTF-8 -classpath $taskApi -d $taskClasses @taskSources
if ($LASTEXITCODE -ne 0) { throw 'Android Java compilation failed' }
& $taskJavac --release 17 -encoding UTF-8 -d $taskTestClasses (Join-Path $taskAndroidRoot 'app\src\main\java\org\scipaper\mobile\ConnectionPolicy.java') (Join-Path $taskAndroidRoot 'tests\ConnectionPolicyTest.java')
if ($LASTEXITCODE -ne 0) { throw 'Connection policy test compilation failed' }
& $taskJava -classpath $taskTestClasses org.scipaper.mobile.ConnectionPolicyTest
if ($LASTEXITCODE -ne 0) { throw 'Connection policy tests failed' }
$taskClassesJar = Join-Path $taskBuildRoot 'classes.jar'
& $taskJar --create --file $taskClassesJar -C $taskClasses .
if ($LASTEXITCODE -ne 0) { throw 'Class packaging failed' }
& $taskJava -cp (Join-Path $ToolsDirectory 'r8.jar') com.android.tools.r8.D8 --release --min-api 29 --lib $taskApi --output $taskDex $taskClassesJar
if ($LASTEXITCODE -ne 0) { throw 'DEX compilation failed' }
$taskPackagerClasspath = (Join-Path $ToolsDirectory 'apksig.jar') + ';' + (Join-Path $ToolsDirectory 'zipflinger.jar')
& $taskJavac --release 17 -classpath $taskPackagerClasspath -d $taskToolsClasses (Join-Path $PSScriptRoot 'AssembleApk.java')
if ($LASTEXITCODE -ne 0) { throw 'APK packaging tool compilation failed' }
$taskPreviousPassword = $env:SCIPAPER_SIGNING_PASSWORD
try {
    if (!$SigningStore) {
        $SigningStore = Join-Path $ToolsDirectory 'scipaper-preview.p12'
        $env:SCIPAPER_SIGNING_PASSWORD = 'android'
        if (!(Test-Path -LiteralPath $SigningStore)) {
            & (Join-Path $JdkHome 'bin\keytool.exe') -genkeypair -keystore $SigningStore -storetype PKCS12 -storepass android -keypass android -alias scipaper-preview -keyalg RSA -keysize 2048 -validity 3650 -dname 'CN=SciPaper Preview' -noprompt
            if ($LASTEXITCODE -ne 0) { throw 'Preview signing key generation failed' }
        }
    } elseif (!$env:SCIPAPER_SIGNING_PASSWORD) {
        throw 'Set SCIPAPER_SIGNING_PASSWORD for the supplied signing store.'
    }
    if (!$OutputPath) { $OutputPath = Join-Path $taskMobileRoot 'build\SciPaper-Android-0.1.0-preview.1.apk' }
    $taskSignedApk = Join-Path $taskBuildRoot 'signed.apk'
    & $taskJava -classpath ($taskToolsClasses + ';' + $taskPackagerClasspath) AssembleApk $taskResourceApk (Join-Path $taskDex 'classes.dex') $SigningStore (Join-Path $taskBuildRoot 'unsigned.apk') $taskSignedApk
    if ($LASTEXITCODE -ne 0) { throw 'APK packaging or signature verification failed' }
    & $taskAapt dump badging $taskSignedApk
    if ($LASTEXITCODE -ne 0) { throw 'APK manifest validation failed' }
    New-Item -ItemType Directory -Path (Split-Path $OutputPath -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $taskSignedApk -Destination $OutputPath
    Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256
} finally {
    $env:SCIPAPER_SIGNING_PASSWORD = $taskPreviousPassword
}
