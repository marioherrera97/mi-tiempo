"""Compila la APK de Mi Tiempo con las herramientas del SDK de Android (sin Gradle).

Uso:  python android/build.py [versionCode] [versionName]
Salida: android/MiTiempo.apk

La primera vez crea una clave de firma en android/release.keystore (no se sube a Git).
Guárdala: para instalar actualizaciones encima de la app hace falta firmar siempre con la misma.
"""
import os
import secrets
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD = HERE / 'build'
OUT = HERE / 'MiTiempo.apk'
PACKAGE = 'com.marioherrera.mitiempo'
MIN_SDK, TARGET_SDK = 24, 34

version_code = sys.argv[1] if len(sys.argv) > 1 else '1'
version_name = sys.argv[2] if len(sys.argv) > 2 else '1.0'


def find_sdk():
    for env in ('ANDROID_HOME', 'ANDROID_SDK_ROOT'):
        if os.environ.get(env):
            return Path(os.environ[env])
    p = Path(os.environ.get('LOCALAPPDATA', '')) / 'Android' / 'Sdk'
    if p.exists():
        return p
    sys.exit('No encuentro el SDK de Android (instala Android Studio o define ANDROID_HOME).')


def latest(folder):
    vers = sorted((d for d in folder.iterdir() if d.is_dir()), key=lambda d: [int(x) if x.isdigit() else 0 for x in d.name.replace('android-', '').split('.')])
    return vers[-1]


def run(*cmd):
    print('>', ' '.join(str(c) for c in cmd[:3]), '…')
    subprocess.run([str(c) for c in cmd], check=True)


sdk = find_sdk()
bt = latest(sdk / 'build-tools')
platform = latest(sdk / 'platforms')
android_jar = platform / 'android.jar'
exe = '.exe' if os.name == 'nt' else ''
bat = '.bat' if os.name == 'nt' else ''
aapt2, zipalign = bt / f'aapt2{exe}', bt / f'zipalign{exe}'
d8, apksigner = bt / f'd8{bat}', bt / f'apksigner{bat}'
java_home = Path(os.environ['JAVA_HOME']) if os.environ.get('JAVA_HOME') else None
javac = (java_home / 'bin' / f'javac{exe}') if java_home else 'javac'
keytool = (java_home / 'bin' / f'keytool{exe}') if java_home else 'keytool'
print(f'SDK: {sdk}\nbuild-tools {bt.name}, {platform.name}')

shutil.rmtree(BUILD, ignore_errors=True)
for d in ('res', 'gen', 'classes', 'dex'):
    (BUILD / d).mkdir(parents=True)

# 1. Recursos y manifiesto
run(aapt2, 'compile', '--dir', HERE / 'res', '-o', BUILD / 'res' / 'res.zip')
run(aapt2, 'link', '-o', BUILD / 'base.apk', '-I', android_jar, '--manifest', HERE / 'AndroidManifest.xml',
    '--min-sdk-version', MIN_SDK, '--target-sdk-version', TARGET_SDK,
    '--version-code', version_code, '--version-name', version_name,
    '--java', BUILD / 'gen', BUILD / 'res' / 'res.zip')

# 2. Java -> .class -> classes.dex
sources = [str(p) for p in (HERE / 'src').rglob('*.java')] + [str(p) for p in (BUILD / 'gen').rglob('*.java')]
run(javac, '-source', '8', '-target', '8', '-nowarn', '-Xlint:-options', '-encoding', 'UTF-8',
    '-bootclasspath', android_jar, '-d', BUILD / 'classes', *sources)
classes = [str(p) for p in (BUILD / 'classes').rglob('*.class')]
run(d8, '--release', '--min-api', MIN_SDK, '--lib', android_jar, '--output', BUILD / 'dex', *classes)

# 3. Añadir el código al paquete, alinear y firmar
unsigned = BUILD / 'unsigned.apk'
shutil.copy(BUILD / 'base.apk', unsigned)
with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(BUILD / 'dex' / 'classes.dex', 'classes.dex')
aligned = BUILD / 'aligned.apk'
run(zipalign, '-f', '-p', '4', unsigned, aligned)

ks, props = HERE / 'release.keystore', HERE / 'keystore.properties'
if not ks.exists():
    pwd = secrets.token_urlsafe(18)
    run(keytool, '-genkeypair', '-keystore', ks, '-alias', 'mitiempo', '-keyalg', 'RSA', '-keysize', '2048',
        '-validity', '10000', '-storepass', pwd, '-keypass', pwd, '-dname', 'CN=Mi Tiempo, O=Personal, C=ES')
    props.write_text(f'storePassword={pwd}\nkeyAlias=mitiempo\n', encoding='utf8')
    print(f'Clave de firma creada en {ks} (guárdala junto con {props.name}).')
pwd = dict(line.split('=', 1) for line in props.read_text(encoding='utf8').splitlines() if '=' in line)['storePassword']
run(apksigner, 'sign', '--ks', ks, '--ks-key-alias', 'mitiempo', '--ks-pass', f'pass:{pwd}', '--key-pass', f'pass:{pwd}',
    '--out', OUT, aligned)
run(apksigner, 'verify', OUT)
print(f'\nAPK lista: {OUT} ({OUT.stat().st_size // 1024} KB)')
