# KirinDNS — Demo Sites and Use Cases

This document describes practical demonstrations and use cases that
showcase the value of the KirinDNS Resolution Protocol (ADRP). These demos
are designed to be replicable by developers, presenters, and potential
partners.

---

## Use Case 1: Web3 dApp on a Non-Standard Port

### Scenario

A developer runs an IPFS gateway on their local machine at port 3000.
Without ADRP, users must navigate to `http://localhost:3000` to access
the gateway. With ADRP, they can simply go to `http://ipfs.local` and
the browser automatically connects to port 3000.

### Setup

1. **Run an IPFS gateway on port 3000:**
   ```bash
   ipfs daemon --address="/ip4/127.0.0.1/tcp/3000"
   ```

2. **Publish the ADRP TXT record:**
   ```json
   {"http": 3000}
   ```

3. **Install the KirinDNS extension** in Chrome.

4. **Navigate to `http://ipfs.local`** — the extension resolves the
   TXT record, discovers port 3000, and redirects the request to
   `http://ipfs.local:3000`.

### What the User Sees

- Address bar: `http://ipfs.local` (no port number visible)
- Content: The IPFS gateway page loads normally
- Network tab (DevTools): Shows the redirect from port 80 to port 3000

### Why This Matters

- **Web3 onboarding:** New users don't need to understand port numbers.
- **Local development:** Developers can test dApps on standard URLs.
- **Demo-ready:** Present dApps at conferences without explaining port
  configuration.

---

## Use Case 2: Corporate Internal Site Behind a Reverse Proxy

### Scenario

A corporation runs an internal HR portal on port 8080 behind a reverse
proxy. Employees access it at `https://hr.company.internal`. Without
ADRP, they must type `https://hr.company.internal:8080`. With ADRP,
the standard URL works.

### Setup

1. **Run the HR portal on port 8080:**
   ```bash
   # Example: Express.js server on port 8080
   node server.js  # listens on :8080
   ```

2. **Configure the reverse proxy (Nginx):**
   ```nginx
   server {
       listen 8080;
       server_name hr.company.internal;

       location / {
           proxy_pass http://127.0.0.1:8080;
       }
   }
   ```

3. **Publish the ADRP TXT record:**
   ```json
   {"https": 8080}
   ```

4. **Install the KirinDNS extension** in the corporate browser.

5. **Navigate to `https://hr.company.internal`** — the extension
   resolves the TXT record and redirects to port 8080.

### What the User Sees

- Address bar: `https://hr.company.internal` (clean URL)
- Content: The HR portal loads normally
- No certificate errors (assuming the certificate is valid for the
  domain)

### Why This Matters

- **Reduced training overhead:** Employees don't need to learn about
  port numbers.
- **Consistent URLs:** Documentation and bookmarks use clean URLs.
- **Multi-tenant support:** Multiple internal services on different
  ports, all accessible via clean URLs.

---

## Use Case 3: Privacy-Focused DNS Resolver with Custom Ports

### Scenario

A privacy-focused DNS resolver (e.g., based on DoT or DoH) runs on
non-standard ports to avoid ISP detection and throttling. ADRP allows
clients to discover the correct port automatically.

### Setup

1. **Run a DoT resolver on port 853 and a DoH resolver on port 4433:**
   ```bash
   # Example: CoreDNS with custom ports
   # Corefile:
   # .:853 { dot }
   # .:4433 { dnsproxy https://cloudflare-dns.com/dns-query }
   ```

2. **Publish the ADRP TXT record for the resolver domain:**
   ```json
   {"https": 4433}
   ```

3. **Configure the client to use the ADRP extension** (or ADRP-aware
   library) for DNS resolution.

4. **The client resolves the ADRP TXT record**, discovers port 4433,
   and connects to the DoH resolver on that port.

### What the User Sees

- No visible port number in any configuration
- DNS queries are routed through the custom resolver on the correct port
- ISP cannot easily identify the resolver (non-standard port)

### Why This Matters

- **Privacy:** Non-standard ports make it harder for ISPs to identify
  and throttle DNS-over-HTTPS traffic.
- **Resilience:** If an ISP blocks standard DoH ports (853, 443), the
  resolver can switch to a non-standard port and advertise it via ADRP.
- **Flexibility:** The resolver operator can change ports without
  requiring clients to update their configuration.

---

## Use Case 4: Multi-Service Single-IP Deployment

### Scenario

A developer runs multiple services on a single IP address, each on a
different port:
- Web app on port 3000
- API on port 4000
- Admin panel on port 5000

With ADRP, each service is accessible via a clean URL:
- `https://app.example.com` -> port 3000
- `https://api.example.com` -> port 4000
- `https://admin.example.com` -> port 5000

### Setup

1. **Publish separate ADRP TXT records for each subdomain:**
   ```
   app.example.com.    TXT  {"https": 3000}
   api.example.com.    TXT  {"https": 4000}
   admin.example.com.  TXT  {"https": 5000}
   ```

2. **Install the KirinDNS extension.**

3. **Navigate to any subdomain** — the extension resolves the correct
   port for each service.

### What the User Sees

- Clean URLs for all services (no port numbers)
- Each subdomain automatically connects to the correct service

### Why This Matters

- **Cost-effective hosting:** Multiple services on a single IP.
- **Simple management:** DNS TXT records are easy to update.
- **Developer-friendly:** No need to configure reverse proxies for
  port-based routing.

---

## Use Case 5: Web3 Node Frontend with Dynamic Port Discovery

### Scenario

A Web3 node operator runs their node frontend on a port that changes
periodically (e.g., for security rotation). With ADRP, users always
access the node via a standard URL, and the port is discovered
automatically.

### Setup

1. **Run the node frontend on a rotating port:**
   ```bash
   node frontend.js --port 9090  # changes periodically
   ```

2. **Update the ADRP TXT record when the port changes:**
   ```bash
   # Using Cloudflare API to update TXT record
   curl -X PATCH "https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{record_id}" \
     -H "Authorization: Bearer {api_token}" \
     -H "Content-Type: application/json" \
     -d '{"type":"TXT","name":"node.example.com","content":"{\"https\":9090}"}'
   ```

3. **Users navigate to `https://node.example.com`** — the extension
   always resolves the current port.

### What the User Sees

- Always the same URL: `https://node.example.com`
- The node frontend loads regardless of what port it's running on

### Why This Matters

- **Security:** Port rotation is a security practice; ADRP makes it
  user-transparent.
- **Reliability:** If a port is blocked, the operator can change it
  and update the TXT record without informing users.
- **Dynamic scaling:** New instances can be deployed on different ports
  and advertised via ADRP.

---

## Demo Infrastructure

### Recommended Demo Environment

For live demos and presentations, use the following setup:

1. **Local machine or cloud VM** with: multiple services on different
   ports, a local DNS server (e.g., dnsmasq) configured to serve ADRP
   TXT records.

2. **Cloudflare DNS** for public demos: publish ADRP TXT records in
   a Cloudflare-managed domain.

3. **KirinDNS Chrome extension** installed in the demo browser.

4. **DevTools open** on the Network tab to show the ADRP resolution
   flow (TXT query -> port discovery -> redirect).

### Demo Script

1. Show the address bar with a clean URL (no port).
2. Navigate to the URL.
3. Show the Network tab in DevTools:
   - TXT query to Cloudflare DoH
   - ADRP JSON response with port
   - Redirect to the correct port
4. Show the content loading normally.
5. Disable the extension and show the "connection refused" error on the
   default port — demonstrating the problem ADRP solves.
6. Re-enable the extension and show it working again.

---

## Contributing New Use Cases

If you have a creative use case for ADRP, we welcome contributions. Open
a pull request on the KirinDNS repository with your use case added to this
document. Include:

1. A clear scenario description.
2. Setup instructions.
3. What the user sees.
4. Why this matters.

The best use cases will be featured in the ADRP documentation and may be
used in conference presentations.
