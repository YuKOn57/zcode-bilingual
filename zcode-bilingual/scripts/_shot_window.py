import os, sys
import win32gui, win32ui, win32con, win32process
from PIL import Image

OUT = r'C:\Users\YuKOn\Documents\zcode\_shots'
os.makedirs(OUT, exist_ok=True)

def enum():
    res = []
    def cb(h, _):
        if not win32gui.IsWindowVisible(h): return
        t = win32gui.GetWindowText(h)
        c = win32gui.GetClassName(h)
        if not t: return
        try:
            _, pid = win32process.GetWindowThreadProcessId(h)
        except Exception:
            pid = 0
        r = win32gui.GetWindowRect(h)
        w, ht = r[2]-r[0], r[3]-r[1]
        res.append((h, c, t, pid, w, ht))
    win32gui.EnumWindows(cb, None)
    return res

wins = enum()
zcode_pids = set()
import subprocess
tl = subprocess.run(['tasklist', '/FO', 'CSV', '/NH'], capture_output=True, text=True, encoding='gbk', errors='replace').stdout
for line in tl.splitlines():
    if 'ZCode.exe' in line:
        zcode_pids.add(int(line.split(',')[1].strip('"')))

print('ZCode pids:', len(zcode_pids))
cands = [w for w in wins if w[3] in zcode_pids and w[4] > 400 and w[5] > 300]
for c in sorted(cands, key=lambda x: -x[4]*x[5]):
    print(c)

def shot(h, path):
    r = win32gui.GetWindowRect(h)
    w, ht = r[2]-r[0], r[3]-r[1]
    hwndDC = win32gui.GetWindowDC(h)
    mfcDC = win32ui.CreateDCFromHandle(hwndDC)
    saveDC = mfcDC.CreateCompatibleDC()
    bmp = win32ui.CreateBitmap()
    bmp.CreateCompatibleBitmap(mfcDC, w, ht)
    saveDC.SelectObject(bmp)
    ok = ctypes.windll.user32.PrintWindow(h, saveDC.GetSafeHdc(), 2)
    bmpinfo = bmp.GetInfo()
    bmpstr = bmp.GetBitmapBits(True)
    im = Image.frombuffer('RGB', (bmpinfo['bmWidth'], bmpinfo['bmHeight']), bmpstr, 'raw', 'BGRX', 0, 1)
    im.save(path)
    win32gui.ReleaseDC(h, hwndDC)
    saveDC.DeleteDC(); mfcDC.DeleteDC()
    try: win32gui.DeleteObject(bmp.GetHandle())
    except Exception: pass
    return ok

import ctypes
n = 0
for h, c, t, pid, w, ht in sorted(cands, key=lambda x: -x[4]*x[5])[:6]:
    n += 1
    p = os.path.join(OUT, f'zcode_{n}.png')
    ok = shot(h, p)
    print('shot', p, 'ok=', ok, w, ht, t[:60])
