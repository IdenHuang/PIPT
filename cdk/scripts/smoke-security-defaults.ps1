<#
.SYNOPSIS
  Post-deploy smoke tests for the secure-by-default controls (finding f-ae0e72c9):
  SPA security headers/CSP, WAF body rules, fixed gateway error messages,
  CORS preflight, and the Bedrock guardrail PII policy.

.DESCRIPTION
  No credentials are needed for the HTTP checks: they send UNAUTHENTICATED
  requests and tell the WAF and the authorizer apart by status code
  (WAF block = 403, request that got past the WAF to the authorizer = 401).
  The guardrail checks call bedrock-runtime ApplyGuardrail with your current
  AWS CLI credentials and only run when -GuardrailId is given.

  Run against dev first. Works on Windows PowerShell 5.1 and PowerShell 7.

.EXAMPLE
  ./smoke-security-defaults.ps1 `
    -FrontendUrl https://main.d3uv171xv91wfq.amplifyapp.com `
    -ApiUrl https://abc123.execute-api.ca-central-1.amazonaws.com/prod/ `
    -AllowedOrigin https://main.d3uv171xv91wfq.amplifyapp.com `
    -GuardrailId abcd1234efgh -Region ca-central-1 -Profile pipt-dev
#>
param(
  [Parameter(Mandatory)] [string] $FrontendUrl,
  [Parameter(Mandatory)] [string] $ApiUrl,          # stage URL, e.g. https://<id>.execute-api.<region>.amazonaws.com/prod/
  [Parameter(Mandatory)] [string] $AllowedOrigin,   # an origin in the CORS allowlist
  [string] $GuardrailId,
  [string] $Region,
  [string] $Profile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$http = [System.Net.Http.HttpClient]::new()
$ApiUrl = $ApiUrl.TrimEnd('/') + '/'
$script:failures = 0

function Check([string] $name, [bool] $ok, [string] $detail = '') {
  if ($ok) { Write-Host "PASS  $name" -ForegroundColor Green }
  else { Write-Host "FAIL  $name  $detail" -ForegroundColor Red; $script:failures++ }
}

function Send([string] $method, [string] $url, [string] $body = $null, [hashtable] $headers = @{}) {
  $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($method), $url)
  foreach ($k in $headers.Keys) { [void] $req.Headers.TryAddWithoutValidation($k, $headers[$k]) }
  if ($null -ne $body) { $req.Content = [System.Net.Http.StringContent]::new($body, [Text.Encoding]::UTF8, 'application/json') }
  $res = $http.SendAsync($req).GetAwaiter().GetResult()
  [pscustomobject]@{
    Status  = [int] $res.StatusCode
    Body    = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    Headers = $res.Headers
    Content = $res.Content.Headers
  }
}

function Header($res, [string] $name) {
  $values = $null
  if ($res.Headers.TryGetValues($name, [ref] $values)) { return ($values -join ', ') }
  if ($res.Content.TryGetValues($name, [ref] $values)) { return ($values -join ', ') }
  return $null
}

# Required query params so the request passes the params-only validator and
# reaches the authorizer (=> 401 without a token).
$textGen = "${ApiUrl}student/text_generation?simulation_group_id=smoke&session_id=smoke&patient_id=smoke"
$personaMedia = "${ApiUrl}instructor/persona_media?persona_id=smoke"
$pad = { param([int] $bytes) '{"message_content":"' + ('a' * $bytes) + '"}' }

Write-Host "`n== 1. SPA security headers ($FrontendUrl)" -ForegroundColor Cyan
$page = Send 'GET' $FrontendUrl
Check 'frontend returns 200' ($page.Status -eq 200) "got $($page.Status)"
Check 'Strict-Transport-Security' ((Header $page 'Strict-Transport-Security') -match 'max-age=31536000')
Check 'X-Content-Type-Options: nosniff' ((Header $page 'X-Content-Type-Options') -eq 'nosniff')
Check 'X-Frame-Options: DENY' ((Header $page 'X-Frame-Options') -eq 'DENY')
Check 'Referrer-Policy' ([bool] (Header $page 'Referrer-Policy'))
$enforced = Header $page 'Content-Security-Policy'
$reportOnly = Header $page 'Content-Security-Policy-Report-Only'
$csp = if ($enforced) { $enforced } else { $reportOnly }
Check 'CSP header present' ([bool] $csp)
if ($csp) {
  Write-Host ("      mode: " + $(if ($enforced) { 'ENFORCED' } else { 'REPORT-ONLY' }))
  Check "CSP script-src is 'self' blob: only" ($csp -match "script-src 'self' blob:;")
  Check "CSP object-src 'none'" ($csp -match "object-src 'none'")
  Check "CSP frame-ancestors 'none'" ($csp -match "frame-ancestors 'none'")
  Check 'CSP tokens resolved (no ${Token})' ($csp -notmatch 'Token\[')
  Check 'CSP connect-src includes this API host' ($csp -match [regex]::Escape(([uri] $ApiUrl).Host))
}
$deep = Send 'GET' ($FrontendUrl.TrimEnd('/') + '/student/some/deep/link')
Check 'SPA deep link also carries CSP' ([bool] ((Header $deep 'Content-Security-Policy') -or (Header $deep 'Content-Security-Policy-Report-Only')))

Write-Host "`n== 2. Gateway error responses" -ForegroundColor Cyan
$unauth = Send 'POST' $textGen (& $pad 10)
Check 'no token -> 401 Unauthorized' ($unauth.Status -eq 401) "got $($unauth.Status)"
Check '401 body is the fixed message' ($unauth.Body -match '"message":"Unauthorized"') $unauth.Body
$missing = Send 'GET' "${ApiUrl}does-not-exist-smoke"
Check 'unknown route body is generic' ($missing.Body -match 'Request rejected' -and $missing.Body -notmatch 'Authentication Token') $missing.Body

Write-Host "`n== 3. WAF body size (limit 64 KB, REST API)" -ForegroundColor Cyan
$small = Send 'POST' $textGen (& $pad 60000)
Check '~60 KB body passes WAF (401 from authorizer)' ($small.Status -eq 401) "got $($small.Status)"
$big = Send 'POST' $textGen (& $pad 70000)
Check '~70 KB body blocked by WAF (403)' ($big.Status -eq 403) "got $($big.Status)"

Write-Host "`n== 4. WAF XSS body rule" -ForegroundColor Cyan
$xss = Send 'POST' $textGen '{"message_content":"<script>alert(document.cookie)</script>"}'
Check '<script> body on student route blocked (403)' ($xss.Status -eq 403) "got $($xss.Status)"
$xssEnc = Send 'POST' $textGen '{"message_content":"%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"}'
Check 'URL-encoded XSS blocked (403)' ($xssEnc.Status -eq 403) "got $($xssEnc.Status)"
$iframe = '{"media_type":"embed","url":"<iframe src=\"https://www.youtube.com/embed/abc\" width=\"560\" height=\"315\"></iframe>","title":"smoke"}'
$embed = Send 'POST' $personaMedia $iframe
Check 'iframe embed on instructor/persona_media passes WAF (401)' ($embed.Status -eq 401) "got $($embed.Status)"
$clinical = Send 'POST' $textGen '{"message_content":"Patient takes 5 mg/day; PHN 9123 456 789; dose < 10 mg and > 2 mg"}'
Check 'clinical free text passes WAF (401)' ($clinical.Status -eq 401) "got $($clinical.Status)"

Write-Host "`n== 5. CORS preflight" -ForegroundColor Cyan
$pre = Send 'OPTIONS' $textGen $null @{ 'Origin' = $AllowedOrigin; 'Access-Control-Request-Method' = 'POST'; 'Access-Control-Request-Headers' = 'authorization,content-type' }
Check 'preflight 200' ($pre.Status -eq 200) "got $($pre.Status)"
Check 'preflight has Access-Control-Allow-Origin' ([bool] (Header $pre 'Access-Control-Allow-Origin'))

if ($GuardrailId) {
  Write-Host "`n== 6. Guardrail PII policy ($GuardrailId, DRAFT)" -ForegroundColor Cyan
  $common = @('bedrock-runtime', 'apply-guardrail', '--guardrail-identifier', $GuardrailId,
    '--guardrail-version', 'DRAFT', '--source', 'INPUT', '--query', 'action', '--output', 'text')
  if ($Region) { $common += @('--region', $Region) }
  if ($Profile) { $common += @('--profile', $Profile) }
  function Guard([string] $text) {
    $file = New-TemporaryFile
    try {
      # Write the content as a file so quoting survives Windows PowerShell -> aws.exe
      ConvertTo-Json -Depth 4 -InputObject @(@{ text = @{ text = $text } }) | Set-Content -Path $file -Encoding ascii
      $out = & aws @common --content "file://$($file.FullName)" 2>&1
      return ($out | Out-String).Trim()
    } finally { Remove-Item $file -Force }
  }
  $cases = @(
    @{ text = 'You can email me at jane.doe@example.com'; expect = 'GUARDRAIL_INTERVENED'; name = 'EMAIL blocked' },
    @{ text = 'My card number is 4111 1111 1111 1111'; expect = 'GUARDRAIL_INTERVENED'; name = 'credit card blocked' },
    @{ text = 'My SIN is 046 454 286'; expect = 'GUARDRAIL_INTERVENED'; name = 'SIN blocked' },
    @{ text = 'Hi, my name is Margaret Chen, I am 67 and I live at 123 Main St. My PHN is 9123 456 789.'; expect = 'NONE'; name = 'persona name/age/address/PHN allowed' },
    @{ text = 'I have been taking 500 mg of metformin twice a day.'; expect = 'NONE'; name = 'normal clinical answer allowed' }
  )
  foreach ($c in $cases) {
    $result = Guard $c.text
    Check $c.name ($result -eq $c.expect) "expected $($c.expect), got $result"
  }
}

Write-Host ''
if ($script:failures -eq 0) { Write-Host 'All automated smoke tests passed.' -ForegroundColor Green }
else { Write-Host "$script:failures check(s) failed." -ForegroundColor Red }

Write-Host @'

Manual browser checks (DevTools console open; with Report-Only, look for
"[Report Only] Refused to ..." messages, which must be zero before enforcing):
  1. Log in (Cognito) and log out.
  2. Student: open a patient, send text chat messages, see the streamed reply (AppSync).
  3. Student: start a voice session (microphone prompt, AudioWorklet, socket).
  4. Student: open patient files (PDF iframe) and profile pictures (CloudFront).
  5. Student: open physical-assessment materials: a YouTube, Panopto and Kaltura embed.
  6. Instructor: upload a document and a patient photo (S3 presigned POST).
  7. Instructor: add/edit a case material with an <iframe> embed code (must save).
  8. Instructor: save a long system prompt (~20-60 KB must save; >64 KB returns 403).
  9. Export a PDF report (jsPDF/html2canvas).
 10. Prompt Playground: voice preview.
When clean, redeploy the Amplify stack with -c CspEnforce=true, rerun this
script (CSP mode should read ENFORCED) and repeat the browser checks.
'@

exit $script:failures
