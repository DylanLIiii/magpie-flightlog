"""Optional browser integration test. Requires magpie, bun and Python Playwright."""
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def exercise(folder):
    gateway, web, service = (free_port() for _ in range(3))
    key = secrets.token_hex(20)
    base = f'http://127.0.0.1:{web}'
    env = dict(PATH=os.environ['PATH'], HOME=str(folder), XDG_CONFIG_HOME=str(folder / 'cfg'),
               XDG_CACHE_HOME=str(folder / 'cache'), MAGPIE_ADDR=f'127.0.0.1:{gateway}',
               MAGPIE_WEB_KEY=key, MAGPIE_BUN=shutil.which('bun'), MAGPIE_NO_ACCOUNTS='1',
               FLIGHTLOG_STATE=str(folder / 'state'), NO_PROXY='*',
               HTTP_PROXY='http://127.0.0.1:1', HTTPS_PROXY='http://127.0.0.1:1')

    def cli(*args):
        return subprocess.run(['magpie', *args], env=env, cwd=folder, check=True,
                              capture_output=True, timeout=40).stdout.decode()

    config = folder / 'cfg' / 'magpie'
    assert str(config) in cli('data'), 'Test requires an isolated Linux XDG profile'
    cli('plugin', 'add', str(ROOT))
    cli('plugin', 'options', 'magpie-flightlog', json.dumps({'port': service}))
    row = {'t':datetime.now(timezone.utc).isoformat(), 'agent':'fixture-client', 'provider':'fixture',
           'model':'gpt-fixture', 'served':'gpt-fixture', 'status':200, 'ms':5000, 'ttft_ms':1000, 'in':25, 'out':50}
    (config / 'usage.jsonl').write_text(json.dumps(row)+'\n')
    proc = subprocess.Popen(['magpie','web','--no-open','--gateway','--addr',f'127.0.0.1:{web}'],
                            env=env,cwd=folder,start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor())
        for _ in range(100):
            try:
                opener.open(base+'/?k='+key,timeout=2).close()
                break
            except OSError:
                time.sleep(.2)
        pages=json.load(opener.open(base+'/api/plugin-pages',timeout=10))
        page=next(p for p in (pages if isinstance(pages,list) else pages['pages']) if p['title']=='Flightlog')
        assert page['service']
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=os.getenv('FLIGHTLOG_CHROMIUM'),args=['--disable-dev-shm-usage'])
            tab=browser.new_page(viewport={'width':1240,'height':900})
            tab.goto(base+'/?k='+key+'&view='+page['key'],wait_until='domcontentloaded')
            sidebar=tab.locator('[data-view="'+page['key']+'"]')
            if sidebar.count() and sidebar.first.is_visible():
                sidebar.first.click()
            frame=None
            for _ in range(120):
                frame=next((f for f in tab.frames if '/_magpie/service/' in f.url),None)
                if frame: break
                tab.wait_for_timeout(250)
            assert frame, 'Expected the real sandboxed service frame'
            frame.get_by_text('索引已同步',exact=False).first.wait_for(timeout=45000)
            assert frame.locator('.requestcount').inner_text().startswith('1 ')
            for name in ['1 天','14 天','30 天','全部','7 天']:
                frame.get_by_role('link',name=name,exact=True).first.click()
                frame.wait_for_load_state('domcontentloaded')
            for field,value in [('family','GPT'),('model','gpt-fixture'),('client','fixture-client')]:
                frame.locator('#'+field).select_option(value)
            frame.get_by_role('link',name='并发',exact=True).click()
            frame.get_by_text('分段明细',exact=True).click()
            assert frame.locator('details[open] tbody tr').count()==48
            tab.emulate_media(reduced_motion='reduce')
            tab.set_viewport_size({'width':390,'height':844})
            frame.wait_for_function('innerWidth<400 && document.documentElement.scrollWidth<=innerWidth+1')
            assert frame.locator('.plot svg').evaluate('e=>getComputedStyle(e).animationName')=='none'
            browser.close()
    finally:
        os.killpg(proc.pid,signal.SIGTERM)
        proc.wait(timeout=10)


if __name__=='__main__':
    with tempfile.TemporaryDirectory(prefix='flightlog-test-') as folder:
        exercise(Path(folder))
    print('Magpie host and Chromium integration passed.')
