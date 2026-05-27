"""
PAM QA Report Generator — GitHub Actions (v4)
==============================================
Teardown hooks (running inside Autosana) collect all flow run data and
dispatch it in the GitHub payload. This script reads that data directly —
no Autosana API calls needed here.

Pipeline:
  1. Read suite_id / suite_name / run_date / flows from PAYLOAD_FILE
  2. Classify all flows with Claude API
  3. Generate PDF report
  4. Create Confluence page
  5. Update Google Sheet
  6. Send Slack notification
"""

import os, sys, json, base64, datetime
import urllib.request, urllib.parse, urllib.error
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak
)
from reportlab.lib.enums import TA_CENTER

# ── Config ────────────────────────────────────────────────────────────────────
ANTHROPIC_API        = "https://api.anthropic.com/v1/messages"
CONFLUENCE_BASE      = "https://trivelta.atlassian.net/wiki/api/v2"
CONFLUENCE_SPACE_ID  = "4161539"
CONFLUENCE_PARENT_ID = "759562269"
SPREADSHEET_ID       = "1iQLh2LxEi5HVofd2nv191FcjW4OWMMajjKav5-AeZR8"

# Row ranges in the Google Sheet for each suite (start_row, end_row inclusive)
SUITE_SHEET_ROWS = {
    "d489f392-5d20-4689-87ff-e8b2e0b7f0e4": (37, 57),  # PAM Agent Audit Log
    # "14fb0e17-faf3-487e-ae18-9ca01dde84c5": (X, Y),  # PAM Affiliates — add once confirmed
    # "615d740d-bb78-417b-8eaa-052f82dffe0d": (X, Y),  # PAM Users Tab
    # "78b9916f-2d93-4af3-9739-98a5bae1d57a": (X, Y),  # PAM Casino Reports
}

ANTHROPIC_KEY        = os.environ["ANTHROPIC_API_KEY"]
CONFLUENCE_EMAIL     = os.environ["CONFLUENCE_EMAIL"]
CONFLUENCE_TOKEN     = os.environ["CONFLUENCE_API_TOKEN"]
GOOGLE_CLIENT_ID     = os.environ["GOOGLE_CLIENT_ID"]
GOOGLE_CLIENT_SECRET = os.environ["GOOGLE_CLIENT_SECRET"]
GOOGLE_REFRESH_TOKEN = os.environ["GOOGLE_REFRESH_TOKEN"]
SLACK_WEBHOOK        = os.environ.get("SLACK_WEBHOOK_URL", "")
PAYLOAD_FILE         = os.environ["PAYLOAD_FILE"]


# ── Step 1: Load payload (flows collected by teardown hook) ───────────────────
def load_payload():
    with open(PAYLOAD_FILE) as f:
        payload = json.load(f)
    suite_id    = payload["suite_id"]
    suite_name  = payload["suite_name"]
    run_date    = payload.get("run_date", datetime.date.today().isoformat())
    flows       = payload.get("flows", [])
    environment = payload.get("environment", "staging")
    print(f"[1] Loaded {len(flows)} flows for {suite_name} ({run_date}) [{environment}]")
    return suite_id, suite_name, run_date, flows, environment


# ── Step 4: Classify with Claude ──────────────────────────────────────────────
CLASSIFY_PROMPT = """\
You are a senior QA analyst reviewing automated test results for the {suite_name} suite.

For each flow, classify it using EXACTLY one of these labels:
- "Pass" — completed successfully, no issues observed
- "Pass (with bugs)" — passed but the AI review flagged unexpected UI behaviour or bugs
- "Legitimate Failure" — the product behaved incorrectly (missing element, wrong data, broken feature, API error)
- "Agent Error" — test failed because the agent made a mistake (wrong click, hallucination) — NOT a product defect
- "N/A" — could not run (missing env var, TBD instructions, environment issue)

Also provide:
- stg_result: "Pass", "Fail", or "N/A"  (Agent Errors → Pass; Legitimate Failures → Fail)
- legitimate_failure: "Yes" if Legitimate Failure, "No" if Pass/Agent Error, "" if N/A
- summary: 1-2 sentence plain-English summary of what happened or what failed
- severity: For "Legitimate Failure" only — one of: "Critical / Blocker", "High", "Medium", "Low".
  Critical = blocks core functionality or causes data loss / session issues.
  High = important feature is broken but the app is still usable.
  Medium = minor UX issue, edge case, or cosmetic problem.
  Leave empty string for all other classifications.
- bugs: list of specific bug descriptions (empty list if none)
- expected_behaviour: For "Legitimate Failure" only — 1-2 sentences describing what SHOULD have
  happened. Be specific to this feature — reference the actual feature name and expected outcome.
  Example: "After clicking the Date column header, Casino Reports should re-sort in-place without
  disrupting the user session." Leave empty string for all other classifications.
- acceptance_criteria: For "Legitimate Failure" only — list of 3-4 short, specific, testable
  conditions that must be true for the bug to be considered fixed. Each item should be a complete
  sentence starting with a verb. Example: ["Sort action completes without logging out the user",
  "Session cookie is preserved after any sort interaction"]. Empty list for other classifications.

Return ONLY a valid JSON array — no markdown, no explanation. Each element:
{{
  "flow_id": "...",
  "flow_name": "...",
  "classification": "...",
  "stg_result": "...",
  "legitimate_failure": "...",
  "summary": "...",
  "severity": "...",
  "bugs": [],
  "expected_behaviour": "...",
  "acceptance_criteria": []
}}

Flow data:
{flow_data}
"""

def classify_flows(suite_name, flows):
    print(f"[2] Calling Claude API to classify {len(flows)} flows...")
    compact = [
        {
            "flow_id":      f["flow_id"],
            "flow_name":    f["flow_name"],
            "run_status":   f["run"].get("status", "no_run"),
            "summary":      f["run"].get("summary", ""),
            "issues":       f["run"].get("issues", []),
            "last_actions": f["run"].get("last_actions", []),
        }
        for f in flows
    ]
    prompt = CLASSIFY_PROMPT.format(suite_name=suite_name, flow_data=json.dumps(compact, indent=2))
    body = json.dumps({
        "model": "claude-sonnet-4-6",
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": prompt}]
    }).encode()
    req = urllib.request.Request(
        ANTHROPIC_API, data=body,
        headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01",
                 "Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        result = json.loads(r.read())

    raw = result["content"][0]["text"].strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    classifications = json.loads(raw.strip())
    print(f"    Done — {len(classifications)} flows classified")
    return classifications


# ── Step 5: Generate PDF ──────────────────────────────────────────────────────
DARK_BLUE  = colors.HexColor('#1A3A5C')
MED_BLUE   = colors.HexColor('#2C5F8A')
LIGHT_BLUE = colors.HexColor('#EBF4FF')
GREEN_BG   = colors.HexColor('#D4EDDA')
GREEN      = colors.HexColor('#1E7E34')
RED_BG     = colors.HexColor('#F8D7DA')
RED        = colors.HexColor('#721C24')
ORANGE_BG  = colors.HexColor('#FFF3CD')
ORANGE     = colors.HexColor('#856404')
GREY_BG    = colors.HexColor('#F5F5F5')
GREY       = colors.HexColor('#6C757D')
DIVIDER    = colors.HexColor('#DEE2E6')

def ps(name, **kw):
    d = dict(fontName='Helvetica', fontSize=9, leading=13, textColor=colors.black)
    d.update(kw); return ParagraphStyle(name, **d)

def P(text, style): return Paragraph(str(text), style)

def colored_row(text, fg, bg):
    st = ps('_cb', fontName='Helvetica-Bold', fontSize=8, textColor=fg, leading=11)
    t = Table([[P(text, st)]], colWidths=[7.2*inch])
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),bg),
                            ('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4),
                            ('LEFTPADDING',(0,0),(-1,-1),8)]))
    return t

def sec(text):
    lbl = ps('_sl', fontName='Helvetica-Bold', fontSize=10, textColor=MED_BLUE,
             spaceBefore=14, spaceAfter=5)
    return [HRFlowable(width='100%', thickness=1, color=MED_BLUE, spaceBefore=12, spaceAfter=4),
            P(text.upper(), lbl)]

def generate_pdf(suite_name, run_date, classifications):
    pdf_path = f"PAM_Test_Report_{suite_name.replace(' ','_')}_{run_date}.pdf"
    print(f"[3] Generating PDF → {pdf_path}")

    sm   = ps('sm', fontSize=8, leading=12, spaceAfter=3)
    cell = ps('c',  fontSize=8, leading=11)
    cellb= ps('cb', fontName='Helvetica-Bold', fontSize=8, leading=11)
    h3   = ps('h3', fontName='Helvetica-Bold', fontSize=9, textColor=MED_BLUE,
              spaceBefore=8, spaceAfter=3)
    body = ps('body', fontSize=9, leading=13, spaceAfter=4)

    totals = {c: sum(1 for x in classifications if x["classification"]==c)
              for c in ["Pass","Pass (with bugs)","Legitimate Failure","Agent Error","N/A"]}

    doc = SimpleDocTemplate(pdf_path, pagesize=letter,
                            rightMargin=0.65*inch, leftMargin=0.65*inch,
                            topMargin=0.5*inch, bottomMargin=0.6*inch)
    story = []

    # Header
    ts = ps('tt', fontName='Helvetica-Bold', fontSize=20, textColor=colors.white, leading=24)
    hdr = Table([[P('PAM QA Test Report', ts), P(suite_name, ts)]],
                colWidths=[4.0*inch, 3.2*inch])
    hdr.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,-1),DARK_BLUE),
        ('TOPPADDING',(0,0),(-1,-1),14),('BOTTOMPADDING',(0,0),(-1,-1),14),
        ('LEFTPADDING',(0,0),(0,0),16),('ALIGN',(1,0),(1,0),'RIGHT'),
        ('RIGHTPADDING',(1,0),(1,0),16),('VALIGN',(0,0),(-1,-1),'MIDDLE'),
    ]))
    story.append(hdr)
    sub_s = ps('sub', fontSize=10, textColor=colors.HexColor('#B0C8E0'))
    sub = Table([[P(f'Generated: {run_date}  |  Suite: {suite_name}  |  Automated via GitHub Actions', sub_s)]],
                colWidths=[7.2*inch])
    sub.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),MED_BLUE),
                              ('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5),
                              ('LEFTPADDING',(0,0),(-1,-1),16)]))
    story.append(sub)
    story.append(Spacer(1,12))

    # KPIs
    kpis = [(str(len(classifications)),'Total Flows'),
            (str(totals['Pass']),'Clean Passes'),
            (str(totals['Pass (with bugs)']),'Passes w/ Bugs'),
            (str(totals['Legitimate Failure']),'Real Failures'),
            (str(totals['Agent Error']),'Agent Errors')]
    kpi_cells = []
    for val, lbl in kpis:
        inner = Table([
            [P(val, ps('kv',fontName='Helvetica-Bold',fontSize=20,textColor=DARK_BLUE,alignment=TA_CENTER))],
            [P(lbl, ps('kl',fontName='Helvetica',fontSize=7,textColor=GREY,alignment=TA_CENTER))],
        ], colWidths=[1.3*inch])
        inner.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),LIGHT_BLUE),
                                   ('BOX',(0,0),(-1,-1),0.5,DARK_BLUE),
                                   ('ALIGN',(0,0),(-1,-1),'CENTER'),
                                   ('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]))
        kpi_cells.append(inner)
    story.append(Table([kpi_cells], colWidths=[1.3*inch]*5, hAlign='CENTER'))
    story.append(Spacer(1,10))

    # Flow results table
    story += sec(f'Flow Results — {suite_name}')
    sym = {'Pass':'✓ Pass','Pass (with bugs)':'✓ Pass','Legitimate Failure':'✗ Fail',
           'Agent Error':'~ Pass','N/A':'— N/A'}
    def fg(c):
        if 'Failure' in c: return RED
        if 'Error' in c:   return ORANGE
        if 'N/A' in c:     return GREY
        return GREEN

    tdata = [[P(h,cellb) for h in ['#','Flow Name','Result','Classification','Summary']]]
    for i, cl in enumerate(classifications, 1):
        tdata.append([
            P(str(i), cell),
            P(cl['flow_name'], cell),
            P(sym.get(cl['classification'],'?'),
              ps('r',fontName='Helvetica-Bold',fontSize=8,textColor=fg(cl['classification']),leading=11)),
            P(cl['classification'],
              ps('c2',fontName='Helvetica',fontSize=8,textColor=fg(cl['classification']),leading=11)),
            P(cl.get('summary','')[:120], cell),
        ])

    ft = Table(tdata, colWidths=[0.3*inch,2.2*inch,0.7*inch,1.4*inch,2.6*inch], repeatRows=1)
    ts2 = [('BACKGROUND',(0,0),(-1,0),DARK_BLUE),('TEXTCOLOR',(0,0),(-1,0),colors.white),
           ('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),('FONTSIZE',(0,0),(-1,0),8),
           ('GRID',(0,0),(-1,-1),0.3,DIVIDER),
           ('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4),
           ('LEFTPADDING',(0,0),(-1,-1),4),
           ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,GREY_BG])]
    for i, cl in enumerate(classifications, 1):
        if cl['classification'] == 'Legitimate Failure':
            ts2.append(('BACKGROUND',(0,i),(-1,i),RED_BG))
        elif cl['classification'] == 'N/A':
            ts2.append(('BACKGROUND',(0,i),(-1,i),GREY_BG))
    ft.setStyle(TableStyle(ts2))
    story.append(ft)
    story.append(PageBreak())

    # Failure details
    failures = [c for c in classifications if c['classification']=='Legitimate Failure']
    if failures:
        story += sec('Legitimate Failure Details')
        for f in failures:
            story.append(P(f'<b>{f["flow_name"]}</b>', h3))
            story.append(colored_row('Classification: Legitimate Failure', RED, RED_BG))
            story.append(P(f'<b>Summary:</b> {f.get("summary","")}', sm))
            for bug in f.get('bugs',[]): story.append(P(f'• {bug}', sm))
            story.append(Spacer(1,6))

    # Agent errors
    errors = [c for c in classifications if c['classification']=='Agent Error']
    if errors:
        story += sec('Agent Errors')
        for f in errors:
            story.append(P(f'<b>{f["flow_name"]}</b>', h3))
            story.append(colored_row('Classification: Agent Error', ORANGE, ORANGE_BG))
            story.append(P(f'<b>Summary:</b> {f.get("summary","")}', sm))
            story.append(Spacer(1,6))

    # Bugs in passing tests
    bugs_passing = [c for c in classifications if c.get('bugs') and 'Pass' in c['classification']]
    if bugs_passing:
        story += sec('Bugs Found in Passing Tests')
        for f in bugs_passing:
            story.append(P(f'<b>{f["flow_name"]}</b>', body))
            for bug in f['bugs']: story.append(P(f'• {bug}', sm))
            story.append(Spacer(1,4))

    doc.build(story)
    print(f"    PDF written: {pdf_path}")
    return pdf_path


# ── Step 6: Confluence ────────────────────────────────────────────────────────
def create_confluence_page(suite_name, run_date, suite_id, classifications):
    print("[4] Creating Confluence page...")
    creds = base64.b64encode(f"{CONFLUENCE_EMAIL}:{CONFLUENCE_TOKEN}".encode()).decode()
    totals = {c: sum(1 for x in classifications if x['classification']==c)
              for c in ['Pass','Pass (with bugs)','Legitimate Failure','Agent Error','N/A']}

    def badge(label, color):
        return f'<span data-type="status" data-color="{color}">{label}</span>'

    rows = ""
    for i, cl in enumerate(classifications, 1):
        rc = 'green' if cl['stg_result']=='Pass' else 'red' if cl['stg_result']=='Fail' else 'neutral'
        cc = ('red'     if 'Failure' in cl['classification'] else
              'yellow'  if 'Error'   in cl['classification'] else
              'neutral' if cl['classification']=='N/A'       else 'green')
        rows += (f"<tr><td><p>{i}</p></td><td><p>{cl['flow_name']}</p></td>"
                 f"<td><p>{badge(cl['stg_result'],rc)}</p></td>"
                 f"<td><p>{cl['classification']}</p></td>"
                 f"<td><p>{cl.get('summary','')[:200]}</p></td></tr>")

    failures_html = "".join(
        f"<h3>{f['flow_name']}</h3><p><strong>Summary:</strong> {f.get('summary','')}</p>"
        + "".join(f"<p>• {b}</p>" for b in f.get('bugs',[]))
        for f in classifications if f['classification']=='Legitimate Failure'
    ) or "<p>No legitimate failures this run.</p>"

    html = f"""
<h2>Executive Summary</h2>
<table><thead><tr><th>Metric</th><th>Count</th></tr></thead><tbody>
<tr><td>Total Flows</td><td>{len(classifications)}</td></tr>
<tr><td>{badge('Pass (clean)','green')}</td><td>{totals['Pass']}</td></tr>
<tr><td>{badge('Pass (with bugs)','green')}</td><td>{totals['Pass (with bugs)']}</td></tr>
<tr><td>{badge('Legitimate Failures','red')}</td><td>{totals['Legitimate Failure']}</td></tr>
<tr><td>{badge('Agent Errors','yellow')}</td><td>{totals['Agent Error']}</td></tr>
<tr><td>{badge('Not Run / N/A','neutral')}</td><td>{totals['N/A']}</td></tr>
</tbody></table>
<h2>Flow Results — {suite_name}</h2>
<table><thead><tr><th>#</th><th>Flow Name</th><th>Result</th><th>Classification</th><th>Summary</th></tr></thead>
<tbody>{rows}</tbody></table>
<h2>Legitimate Failure Details</h2>{failures_html}"""

    body = {"spaceId": CONFLUENCE_SPACE_ID, "parentId": CONFLUENCE_PARENT_ID,
            "title": f"PAM QA Report — {suite_name} — {run_date}",
            "body": {"representation": "storage", "value": html}}
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{CONFLUENCE_BASE}/pages", data=data,
        headers={"Authorization": f"Basic {creds}", "Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        result = json.loads(r.read())
    url = f"https://trivelta.atlassian.net/wiki{result.get('_links',{}).get('webui','')}"
    print(f"    Confluence page created: {url}")
    return url


# ── Step 7: Google Sheet ──────────────────────────────────────────────────────
def update_sheet(suite_id, run_date, classifications):
    row_range = SUITE_SHEET_ROWS.get(suite_id)
    if not row_range:
        print(f"[5] Skipping Sheet — row range not configured for suite {suite_id}")
        return
    row_start, row_end = row_range
    num_rows = row_end - row_start + 1
    print(f"[5] Updating Google Sheet rows {row_start}–{row_end}...")

    e_vals = [cl["stg_result"]         for cl in classifications[:num_rows]]
    f_vals = [cl["legitimate_failure"]  for cl in classifications[:num_rows]]
    while len(e_vals) < num_rows: e_vals.append(""); f_vals.append("")

    # Exchange refresh token for access token
    params = urllib.parse.urlencode({
        "client_id": GOOGLE_CLIENT_ID, "client_secret": GOOGLE_CLIENT_SECRET,
        "refresh_token": GOOGLE_REFRESH_TOKEN, "grant_type": "refresh_token"
    }).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token", data=params,
        headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST"
    )
    with urllib.request.urlopen(req) as r:
        token = json.loads(r.read())["access_token"]

    payload = json.dumps({
        "valueInputOption": "USER_ENTERED",
        "data": [
            {"range": f"Sheet1!C{row_start}:C{row_end}", "values": [[run_date]]*num_rows},
            {"range": f"Sheet1!E{row_start}:E{row_end}", "values": [[v] for v in e_vals]},
            {"range": f"Sheet1!F{row_start}:F{row_end}", "values": [[v] for v in f_vals]},
        ]
    }).encode()
    req = urllib.request.Request(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values:batchUpdate",
        data=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req) as r:
        result = json.loads(r.read())
    print(f"    Sheet updated — {result.get('totalUpdatedCells')} cells written")


# ── Step 8: Slack notification ────────────────────────────────────────────────
def send_slack(suite_name, run_date, confluence_url, classifications, environment="staging", flows=None):
    if not SLACK_WEBHOOK:
        print("[8] Skipping Slack — SLACK_WEBHOOK_URL not set")
        return

    total     = len(classifications)
    pass_clean = sum(1 for c in classifications if c["classification"] == "Pass")
    pass_bugs  = sum(1 for c in classifications if c["classification"] == "Pass (with bugs)")
    legit_fail = sum(1 for c in classifications if c["classification"] == "Legitimate Failure")
    agent_na   = sum(1 for c in classifications if c["classification"] in ("Agent Error", "N/A"))
    no_run     = sum(1 for c in classifications if c["classification"] == "N/A")
    executed   = total - no_run

    def pct(n): return f"{round(n / total * 100)}%" if total > 0 else "0%"

    # Build lookup: flow_name → raw run data (last_actions, issues)
    flow_detail = {}
    for f in (flows or []):
        flow_detail[f["flow_name"]] = f.get("run", {})

    blocks = [
        {"type": "header", "text": {"type": "plain_text",
            "text": f"PAM QA Automation Report — {run_date}", "emoji": True}},
        {"type": "section", "text": {"type": "mrkdwn",
            "text": f"*{suite_name}*  |  `{environment}`  |  {total} Total Flows ({executed} executed, {no_run} no run records)"}},
        {"type": "divider"},
        {"type": "section", "fields": [
            {"type": "mrkdwn", "text": f":white_check_mark: *Pass (clean)*\n{pass_clean} — {pct(pass_clean)}"},
            {"type": "mrkdwn", "text": f":white_check_mark: *Pass (bugs noted)*\n{pass_bugs} — {pct(pass_bugs)}"},
            {"type": "mrkdwn", "text": f":x: *Legitimate Failures*\n{legit_fail} — {pct(legit_fail)}"},
            {"type": "mrkdwn", "text": f":warning: *Agent / Env / Not Run*\n{agent_na} — {pct(agent_na)}"},
        ]},
    ]

    failures = [c for c in classifications if c["classification"] == "Legitimate Failure"]
    if failures:
        blocks.append({"type": "divider"})
        severity_order  = ["Critical / Blocker", "High", "Medium", "Low"]
        severity_emoji  = {"Critical / Blocker": ":red_circle:", "High": ":large_yellow_circle:",
                           "Medium": ":large_blue_circle:", "Low": ":white_circle:"}
        rc = 1
        for sev in severity_order:
            bucket = [f for f in failures if f.get("severity", "Medium") == sev]
            if not bucket:
                continue
            blocks.append({"type": "section", "text": {"type": "mrkdwn",
                "text": f"{severity_emoji[sev]} *{sev}*"}})
            for f in bucket:
                label = f"RC-{rc}"
                rc += 1
                raw         = flow_detail.get(f["flow_name"], {})
                bugs_list   = [b[:100] for b in f.get("bugs", [])[:3]]
                acts_list   = [a[:90]  for a in raw.get("last_actions", [])[:5]]
                issues_list = []
                for iss in raw.get("issues", [])[:3]:
                    if isinstance(iss, dict):
                        issues_list.append(str(iss.get("message") or iss.get("description") or iss)[:100])
                    else:
                        issues_list.append(str(iss)[:100])
                action_value = json.dumps({
                    "rc":   label,
                    "suite": suite_name,
                    "flow": f["flow_name"][:80],
                    "sev":  sev,
                    "sum":  f.get("summary", f["flow_name"])[:200],
                    "exp":  f.get("expected_behaviour", "")[:200],
                    "crit": [c[:90] for c in f.get("acceptance_criteria", [])[:4]],
                    "bugs": bugs_list,
                    "acts": acts_list,
                    "iss":  issues_list,
                    "env":  environment,
                    "date": run_date,
                }, separators=(",", ":"))
                blocks.append({
                    "type": "section",
                    "text": {"type": "mrkdwn",
                        "text": f"• {label} — {f.get('summary', f['flow_name'])}"},
                    "accessory": {
                        "type":      "button",
                        "text":      {"type": "plain_text", "text": ":beetle: Create Bug", "emoji": True},
                        "style":     "danger",
                        "action_id": "create_jira_bug",
                        "value":     action_value,
                    },
                })

    if confluence_url:
        blocks.append({"type": "divider"})
        blocks.append({"type": "actions", "elements": [
            {"type": "button", "text": {"type": "plain_text", "text": "View Confluence Report", "emoji": True},
             "url": confluence_url}
        ]})

    payload = json.dumps({"blocks": blocks}).encode()
    req = urllib.request.Request(
        SLACK_WEBHOOK, data=payload,
        headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        print(f"[8] Slack notification sent (status {r.status})")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print(f"\n{'='*60}\nPAM Report Pipeline (v4 — payload from teardown hook)\n{'='*60}\n")
    suite_id, suite_name, run_date, flows, environment = load_payload()
    classifications = classify_flows(suite_name, flows)

    # Generate outputs
    generate_pdf(suite_name, run_date, classifications)

    confluence_url = ""
    try:
        confluence_url = create_confluence_page(suite_name, run_date, suite_id, classifications)
    except Exception as e:
        print(f"[6] Confluence error: {e}")

    try:
        update_sheet(suite_id, run_date, classifications)
    except Exception as e:
        print(f"[7] Sheet error: {e}")

    try:
        send_slack(suite_name, run_date, confluence_url, classifications, environment, flows)
    except Exception as e:
        print(f"[8] Slack error: {e}")

    print(f"\n✓ Pipeline complete")

if __name__ == "__main__":
    main()
