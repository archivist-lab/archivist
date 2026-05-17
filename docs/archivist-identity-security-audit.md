# Identity & Security Audit: Multi-Tenant Enterprise Standards

> **Architect's Foreword:**
> The "Arr" ecosystem is traditionally single-user and zero-security (relying on simple API keys). Archivist V2 is built for the **Enterprise Home**—supporting multiple users, granular permissions, and industry-standard authentication protocols (OIDC). Security is not an "add-on"; it is the foundation of the **Vault**.

---

## 1. Authentication: The OIDC Gateway

### 1.1. External Identity Providers (IdP)
Archivist does not store passwords. It delegates authentication to specialized providers:
- **Primary:** **Authentik**, **Keycloak**, or **Authelia**.
- **Protocols:** OpenID Connect (OIDC) and OAuth 2.0.
- **Social/SSO:** Optional support for Google, GitHub, or Discord login (via the IdP).

### 1.2. Zero-Trust API Security
- **Bearer Tokens:** All API calls (Web, Mobile, CLI) must carry a valid JWT (JSON Web Token).
- **Service Accounts:** Internal automation (scripts, bots) utilizes scoped "Service Tokens" with limited lifespans and specific permissions.

---

## 2. Authorization: RBAC (Role-Based Access Control)

Archivist uses a hierarchical RBAC model to manage the **Departments**.

### 2.1. Standard Roles
- **Director (Super Admin):** Global system access, user management, and filesystem config.
- **Curator (Admin):** Full access to a specific **Gallery** (e.g., "Kids Movie Library"). Can approve/deny requests.
- **Patron (User):** Can browse and request media. Can view their own history.
- **Visitor (Guest):** Read-only access to specific collections. No request/download privileges.

### 2.2. Resource-Level Scoping
- **Tenancy:** Support for "Isolated Libraries" where User A cannot see User B's "Private Collection" even on the same physical server.
- **Content Ratings:** Automated restriction based on MPAA/ESRB ratings (e.g., "Patron: Junior" cannot view R-rated content).

---

## 3. Data Integrity & The Vault

### 3.1. Filesystem Permissions
- **The "Archivist" User:** The application runs as a dedicated non-privileged user.
- **Umask Control:** Strict enforcement of 664/775 permissions to ensure interoperability with Plex/Jellyfin/Transmission groups.

### 3.2. Metadata Encryption
- **At-Rest Encryption:** Sensitive configuration (API keys, indexer credentials) is encrypted in the SQLite database using **AES-256-GCM**.
- **Redaction Logic:** Logs automatically scrub 40+ types of credentials before being written to disk or surfaced in the "Care Package."

---

## 4. Network Security

- **SSL/TLS Mandatory:** All external traffic is routed through a Reverse Proxy (Traefik/Nginx) with automated Let's Encrypt certificates.
- **Local Network (LAN) Bypass:** Configurable "Trusted Network" ranges where strict OIDC may be relaxed for TV-based interfaces (e.g., Apple TV/Shield).
- **Audit Logging:** Every sensitive action (delete, download, user-add) is logged with the User-ID, IP, and Timestamp for forensic review.
