# 用 sqlite3 只读打开（WAL 共享读，不复制文件）
import sqlite3, json, ctypes, ctypes.wintypes as wt, os
class B(ctypes.Structure):
    _fields_=[('cbData',wt.DWORD),('pbData',ctypes.POINTER(ctypes.c_byte))]
db = r"C:\Users\LENOVO\AppData\Local\Microsoft\Edge\User Data\Default\Network\Cookies"
# 只读模式 + immutable，避免锁冲突
conn = sqlite3.connect("file:" + db.replace("\\","/") + "?mode=ro&immutable=1", uri=True)
out = {}
for host,name,enc in conn.execute("SELECT host_key,name,encrypted_value FROM cookies WHERE host_key LIKE '%bilibili.com' AND name IN ('bili_jct','SESSDATA','DedeUserID')"):
    if not enc or enc[:3] not in (b'v10',b'v11'): continue
    enc = enc[3:]
    bi = B(len(enc), ctypes.cast(ctypes.create_string_buffer(enc,len(enc)), ctypes.POINTER(ctypes.c_byte)))
    bo = B()
    if ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(bi),None,None,None,None,0,ctypes.byref(bo)):
        out[name] = ctypes.string_at(bo.pbData, bo.cbData).decode('utf-8','replace')
print(json.dumps(out))
