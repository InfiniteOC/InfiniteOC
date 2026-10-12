# Spring Security 6 Guide

Comprehensive configuration guide for Spring Security 6 with Spring Boot 3.x.

## Table of Contents

1. [Core Concepts](#1-core-concepts)
2. [SecurityFilterChain Configuration](#2-securityfilterchain-configuration)
3. [Authentication](#3-authentication)
4. [Authorisation](#4-authorisation)
5. [JWT Configuration](#5-jwt-configuration)
6. [OAuth2 Client and Resource Server](#6-oauth2-client-and-resource-server)
7. [CORS Configuration](#7-cors-configuration)
8. [CSRF Protection](#8-csrf-protection)
9. [Method Security](#9-method-security)
10. [Testing Security](#10-testing-security)
11. [Production Hardening](#11-production-hardening)

---

## 1. Core Concepts

Spring Security operates as a filter chain in the servlet pipeline. Every HTTP request passes through a series of security filters before reaching your controller.

**Key types:**
- `SecurityFilterChain` — defines which requests are secured and how.
- `AuthenticationManager` — validates credentials.
- `UserDetailsService` — loads user data from your store.
- `PasswordEncoder` — hashes and verifies passwords.
- `SecurityContext` — holds the current authenticated principal (thread-local).

**Starter:** `spring-boot-starter-security`

Adding this starter alone secures all endpoints with HTTP Basic and a generated password.

---

## 2. SecurityFilterChain Configuration

Spring Security 6 uses lambda DSL exclusively. Each method accepts a `Customizer<T>` lambda.

### REST API Configuration (stateless, JWT)

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain apiSecurity(HttpSecurity http) throws Exception {
        http
            .securityMatcher("/api/**")
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session ->
                session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(HttpMethod.POST, "/api/auth/login").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/auth/register").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .requestMatchers("/api/**").authenticated()
            )
            .exceptionHandling(ex -> ex
                .authenticationEntryPoint((req, res, authEx) -> {
                    res.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                    res.setContentType("application/json");
                    res.getWriter().write("{\"error\":\"Unauthorized\"}");
                })
            );
        return http.build();
    }
}
```

### Web Application Configuration (session-based, form login)

```java
@Bean
SecurityFilterChain webSecurity(HttpSecurity http) throws Exception {
    http
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/", "/css/**", "/js/**", "/images/**").permitAll()
            .requestMatchers("/admin/**").hasRole("ADMIN")
            .anyRequest().authenticated()
        )
        .formLogin(form -> form
            .loginPage("/login")
            .defaultSuccessUrl("/dashboard")
            .permitAll()
        )
        .logout(logout -> logout
            .logoutSuccessUrl("/login?logout")
            .permitAll()
        )
        .rememberMe(remember -> remember
            .tokenValiditySeconds(86400)
        );
    return http.build();
}
```

### Multiple SecurityFilterChains

Define multiple chains with `@Order` and `securityMatcher()`:

```java
@Bean @Order(1)
SecurityFilterChain apiSecurity(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/**")  // Only applies to /api/**
        // ... API config
    return http.build();
}

@Bean @Order(2)
SecurityFilterChain webSecurity(HttpSecurity http) throws Exception {
    // Applies to everything else
    // ... Web config
    return http.build();
}
```

---

## 3. Authentication

### Custom UserDetailsService

```java
@Service
public class AppUserDetailsService implements UserDetailsService {

    private final UserRepository userRepository;

    public AppUserDetailsService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        User user = userRepository.findByUsername(username)
            .orElseThrow(() -> new UsernameNotFoundException("User not found: " + username));

        return org.springframework.security.core.userdetails.User.builder()
            .username(user.getUsername())
            .password(user.getPassword())   // Must be encoded
            .roles(user.getRoles().stream()
                .map(Role::getName)
                .toArray(String[]::new))
            .accountExpired(!user.isActive())
            .accountLocked(user.isLocked())
            .build();
    }
}
```

### Password Encoding

```java
@Bean
PasswordEncoder passwordEncoder() {
    return new BCryptPasswordEncoder(12);  // 12 rounds — good balance
}

// Usage — always encode before saving
String encoded = passwordEncoder.encode(rawPassword);
user.setPassword(encoded);
```

**Never** store plain-text passwords. **Always** use BCrypt (or Argon2/SCrypt for higher security needs).

### AuthenticationManager Bean

```java
@Bean
AuthenticationManager authenticationManager(AuthenticationConfiguration config) throws Exception {
    return config.getAuthenticationManager();
}
```

---

## 4. Authorisation

### URL-Based (in SecurityFilterChain)

```java
.authorizeHttpRequests(auth -> auth
    .requestMatchers("/public/**").permitAll()
    .requestMatchers(HttpMethod.GET, "/api/products/**").permitAll()
    .requestMatchers("/api/admin/**").hasRole("ADMIN")
    .requestMatchers("/api/reports/**").hasAnyRole("ADMIN", "ANALYST")
    .requestMatchers("/api/**").authenticated()
    .anyRequest().denyAll()  // Deny anything not explicitly permitted
)
```

**Rules are evaluated in order** — place specific matchers before general ones.

### Method-Level Security

```java
@Configuration
@EnableMethodSecurity  // Enables @PreAuthorize, @PostAuthorize, @Secured
public class MethodSecurityConfig {}
```

```java
@Service
public class ReportService {

    @PreAuthorize("hasRole('ADMIN')")
    public void deleteReport(Long id) { /* ... */ }

    @PreAuthorize("hasRole('ADMIN') or #userId == authentication.principal.id")
    public UserProfile getProfile(Long userId) { /* ... */ }

    @PreAuthorize("@permissionEvaluator.canAccess(authentication, #projectId)")
    public Project getProject(Long projectId) { /* ... */ }

    @PostAuthorize("returnObject.owner == authentication.name")
    public Document getDocument(Long id) { /* ... */ }
}
```

`@PreAuthorize` uses Spring Expression Language (SpEL). You can call any bean with `@beanName.method()`.

---

## 5. JWT Configuration

### Generating JWTs

```java
@Component
public class JwtTokenProvider {

    @Value("${jwt.secret}") private String secret;
    @Value("${jwt.expiration-ms}") private long expirationMs;

    private SecretKey getSigningKey() {
        return Keys.hmacShaKeyFor(Decoders.BASE64.decode(secret));
    }

    public String generateToken(Authentication authentication) {
        UserDetails userDetails = (UserDetails) authentication.getPrincipal();
        return Jwts.builder()
            .subject(userDetails.getUsername())
            .claim("roles", userDetails.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority).toList())
            .issuedAt(new Date())
            .expiration(new Date(System.currentTimeMillis() + expirationMs))
            .signWith(getSigningKey())
            .compact();
    }

    public String getUsernameFromToken(String token) {
        return Jwts.parser().verifyWith(getSigningKey()).build()
            .parseSignedClaims(token).getPayload().getSubject();
    }

    public boolean validateToken(String token) {
        try {
            Jwts.parser().verifyWith(getSigningKey()).build().parseSignedClaims(token);
            return true;
        } catch (JwtException | IllegalArgumentException e) {
            return false;
        }
    }
}
```

### JWT Authentication Filter

```java
@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private final JwtTokenProvider tokenProvider;
    private final UserDetailsService userDetailsService;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                     HttpServletResponse response,
                                     FilterChain filterChain) throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (header != null && header.startsWith("Bearer ")) {
            String token = header.substring(7);
            if (tokenProvider.validateToken(token)) {
                String username = tokenProvider.getUsernameFromToken(token);
                UserDetails userDetails = userDetailsService.loadUserByUsername(username);
                var auth = new UsernamePasswordAuthenticationToken(
                    userDetails, null, userDetails.getAuthorities());
                SecurityContextHolder.getContext().setAuthentication(auth);
            }
        }
        filterChain.doFilter(request, response);
    }
}
```

Register the filter:
```java
http.addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);
```

---

## 6. OAuth2 Client and Resource Server

### Resource Server (validates incoming JWTs from an auth server)

**Starter:** `spring-boot-starter-oauth2-resource-server`

```yaml
spring.security.oauth2.resourceserver.jwt:
  issuer-uri: https://auth.example.com/realms/myapp
  # Or specify the JWK set URI directly:
  # jwk-set-uri: https://auth.example.com/realms/myapp/protocol/openid-connect/certs
```

```java
http.oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()));
```

That's it — Spring Boot auto-configures JWT decoding and validation from the issuer URI.

### OAuth2 Client (your app logs in via OAuth2)

**Starter:** `spring-boot-starter-oauth2-client`

```yaml
spring.security.oauth2.client:
  registration:
    google:
      client-id: ${GOOGLE_CLIENT_ID}
      client-secret: ${GOOGLE_CLIENT_SECRET}
      scope: openid, profile, email
  provider:
    google:
      authorization-uri: https://accounts.google.com/o/oauth2/v2/auth
      token-uri: https://oauth2.googleapis.com/token
```

---

## 7. CORS Configuration

```java
@Bean
CorsConfigurationSource corsConfigurationSource() {
    CorsConfiguration config = new CorsConfiguration();
    config.setAllowedOrigins(List.of("https://app.example.com"));
    config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
    config.setAllowedHeaders(List.of("Authorization", "Content-Type"));
    config.setAllowCredentials(true);
    config.setMaxAge(3600L);

    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/api/**", config);
    return source;
}
```

In the SecurityFilterChain: `http.cors(cors -> cors.configurationSource(corsConfigurationSource()))`.

---

## 8. CSRF Protection

- **REST APIs (stateless):** Disable CSRF — `.csrf(csrf -> csrf.disable())`. CSRF attacks exploit session cookies; stateless APIs using Bearer tokens are not vulnerable.
- **Web apps (session-based):** Keep CSRF enabled (default). Spring auto-inserts tokens in forms via Thymeleaf's `th:action`.

---

## 9. Method Security

Enable with `@EnableMethodSecurity` on a configuration class.

| Annotation | When Evaluated | Use Case |
|---|---|---|
| `@PreAuthorize` | Before method execution | Check roles, ownership, custom logic |
| `@PostAuthorize` | After method execution | Check return value |
| `@PreFilter` | Before — filters collection parameter | Filter input list by criteria |
| `@PostFilter` | After — filters return collection | Filter results by criteria |
| `@Secured` | Before (simpler, role-only) | Simple role checks |

---

## 10. Testing Security

```java
// Test with mock user
@WebMvcTest(AdminController.class)
class AdminControllerTest {

    @Autowired MockMvc mockMvc;
    @MockBean AdminService adminService;

    @Test
    @WithMockUser(roles = "ADMIN")
    void adminCanAccessDashboard() throws Exception {
        mockMvc.perform(get("/api/admin/dashboard"))
            .andExpect(status().isOk());
    }

    @Test
    @WithMockUser(roles = "USER")
    void regularUserCannotAccessAdmin() throws Exception {
        mockMvc.perform(get("/api/admin/dashboard"))
            .andExpect(status().isForbidden());
    }

    @Test
    void unauthenticatedUserGets401() throws Exception {
        mockMvc.perform(get("/api/admin/dashboard"))
            .andExpect(status().isUnauthorized());
    }
}
```

Use `@WithMockUser` for simple role tests. For custom `UserDetails`, implement `@WithSecurityContext`.

---

## 11. Production Hardening

```java
http
    .headers(headers -> headers
        .contentTypeOptions(Customizer.withDefaults())    // X-Content-Type-Options: nosniff
        .frameOptions(frame -> frame.deny())              // X-Frame-Options: DENY
        .xssProtection(Customizer.withDefaults())         // X-XSS-Protection
        .contentSecurityPolicy(csp ->
            csp.policyDirectives("default-src 'self'"))
        .httpStrictTransportSecurity(hsts ->
            hsts.maxAgeInSeconds(31536000).includeSubDomains(true))
    );
```

**Checklist:**
- [ ] HTTPS enforced (`server.ssl.*` or reverse proxy termination)
- [ ] Security headers configured (CSP, HSTS, X-Frame-Options)
- [ ] Passwords hashed with BCrypt (cost ≥ 10)
- [ ] JWT secrets are strong (256+ bit), rotated, and stored in secrets manager
- [ ] Actuator endpoints secured (only health/info exposed publicly)
- [ ] CORS configured to specific origins (never `*` with credentials)
- [ ] Rate limiting on authentication endpoints
- [ ] Dependencies scanned for CVEs (`mvn org.owasp:dependency-check-maven:check`)
