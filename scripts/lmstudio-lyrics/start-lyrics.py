from pathlib import Path
import fcntl, json, os, shutil, signal, subprocess, time, urllib.request
ROOT=Path(__file__).resolve().parent
LMS=str(Path.home()/'.lmstudio/bin/lms')
MODEL='lyrics-hy18b'

def health():
    try:
        with urllib.request.urlopen('http://127.0.0.1:11435/health',timeout=1) as r:return json.load(r)
    except OSError:return None

def run(*args):return subprocess.run([LMS,*args],check=True)

def main():
    with (ROOT/'startup.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            print('已有启动程序正在运行，不会重复加载模型。');return
        h=health()
        if h and (h.get('model')!=MODEL or h.get('revision')!='hy18b-v6'):
            pid=int((ROOT/'bridge.pid').read_text())
            cmd=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True)
            if str(ROOT/'lmstudio-bridge.mjs') not in cmd:raise RuntimeError('11435 端口不属于本歌词服务，请检查。')
            os.kill(pid,signal.SIGTERM)
            for _ in range(40):
                if not health():break
                time.sleep(.1)
            else:raise RuntimeError('旧歌词服务未退出')
            h=None
        if not h:
            with (ROOT/'bridge.log').open('a') as log:
                p=subprocess.Popen([shutil.which('node'),str(ROOT/'lmstudio-bridge.mjs')],stdout=log,stderr=log,start_new_session=True)
            (ROOT/'bridge.pid').write_text(str(p.pid))
            for _ in range(40):
                h=health()
                if h and h.get('model')==MODEL and h.get('revision')=='hy18b-v6':break
                if p.poll() is not None:raise RuntimeError('歌词服务启动失败，请查看 bridge.log')
                time.sleep(.1)
            else:raise RuntimeError('歌词服务未就绪')
        print('歌词服务已就绪：模型按需加载，空闲 10 分钟卸载。')
        print('Spotify 中按 Command + Shift + L 打开双语歌词。')

if __name__=='__main__':main()
