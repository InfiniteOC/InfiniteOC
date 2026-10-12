---
name: programming-java-spring-framework
description: Expert guidance and automation for programming in Java with the Spring
  Framework and Spring Boot. Covers project setup, dependency injection, auto-configuration,
  Spring MVC and REST controllers, Spring Data JPA and JDBC, Spring Security, testing
  (JUnit 5, MockMvc, Testcontainers), Spring Boot Actuator, configuration management,
  error handling, validation, caching, scheduling, messaging (JMS, AMQP, Kafka), WebSocket,
  Spring Batch, and all official Spring Boot starters. Provides idiomatic patterns,
  production-ready configuration, and deep guidance on the core component library.
  Use this skill whenever the user is writing, debugging, configuring, or architecting
  a Spring Boot or Spring Framework application — REST APIs, web applications, microservices,
  batch jobs, data pipelines, or any Java project using Spring. Also use when the
  user asks about Spring annotations, Spring configuration, Spring dependency injection,
  Spring Data, Spring Security, Spring testing, or any Spring Boot starter, even if
  they don't explicitly mention "Spring." Third-party Spring Boot starters (e.g.,
  Apache Camel starters, non-Spring projects) are out of scope.
metadata:
  opencode/autoinvoke: false
---

This skill guides Java development with the Spring Framework and Spring Boot. It provides idiomatic patterns, production-ready configurations, and deep guidance on every official Spring module.

The user may be:

1. **Building** — creating a new Spring Boot application or adding features to an existing one
2. **Debugging** — diagnosing configuration issues, bean wiring failures, or runtime errors
3. **Architecting** — designing application structure, choosing modules, planning layered architecture
4. **Testing** — writing unit, integration, or end-to-end tests for Spring applications
5. **Configuring** — setting up properties, profiles, security, database connections, or deployment

Adapt guidance to the user's Spring Boot version. Default to **Spring Boot 3.x / Spring Framework 6.x** (Jakarta EE, Java 17+) unless the user specifies otherwise.

---

## Part I: Project Foundation

### Project Structure

A well-structured Spring Boot application follows a layered, package-by-feature approach:

```
com.example.myapp/
├── MyappApplication.java              # @SpringBootApplication entry point
├── config/                            # @Configuration classes
│   ├── SecurityConfig.java
│   ├── WebConfig.java
│   └── CacheConfig.java
├── controller/                        # @RestController / @Controller
│   └── UserController.java
├── service/                           # @Service — business logic
│   └── UserService.java
├── repository/                        # @Repository — data access
│   └── UserRepository.java
├── model/                             # JPA @Entity classes
│   └── User.java
├── dto/                               # Data Transfer Objects
│   ├── CreateUserRequest.java
│   └── UserResponse.java
├── exception/                         # Custom exceptions + @ControllerAdvice
│   ├── ResourceNotFoundException.java
│   └── GlobalExceptionHandler.java
└── mapper/                            # Entity ↔ DTO mapping
    └── UserMapper.java
```

**Guiding principles:**
- The `@SpringBootApplication` class sits at the root package — component scanning finds everything below it.
- Separate concerns by layer (controller, service, repository) and by feature for larger projects.
- DTOs face the API boundary. Entities face the database. Never expose entities directly in API responses.
- Configuration classes live in `config/`. Don't scatter `@Bean` definitions across random classes.

### Dependency Injection

Spring's IoC container is the foundation. Prefer **constructor injection** — it makes dependencies explicit, supports immutability, and works naturally with testing.

```java
@Service
public class OrderService {

    private final OrderRepository orderRepository;
    private final PaymentGateway paymentGateway;

    // Single constructor — @Autowired is implicit in Spring Boot
    public OrderService(OrderRepository orderRepository, PaymentGateway paymentGateway) {
        this.orderRepository = orderRepository;
        this.paymentGateway = paymentGateway;
    }
}
```

**Rules of thumb:**
- **Constructor injection** for required dependencies (default choice).
- **`@Value`** for injecting configuration properties into fields.
- **Avoid field injection** (`@Autowired` on fields) — it hides dependencies and breaks testability.
- **Avoid circular dependencies** — they signal a design problem. Refactor to break the cycle.

### Configuration Management

```yaml
# application.yml — structured, readable
server:
  port: 8080
  shutdown: graceful

spring:
  application:
    name: my-service
  profiles:
    active: ${SPRING_PROFILES_ACTIVE:local}
  datasource:
    url: jdbc:postgresql://${DB_HOST:localhost}:5432/${DB_NAME:mydb}
    username: ${DB_USER:postgres}
    password: ${DB_PASS:postgres}
  jpa:
    open-in-view: false  # Disable OSIV — explicit transaction boundaries
    hibernate:
      ddl-auto: validate  # Never use update/create in production
    properties:
      hibernate:
        default_batch_fetch_size: 16
        order_inserts: true
        order_updates: true

logging:
  level:
    com.example: DEBUG
    org.springframework.web: INFO
    org.hibernate.SQL: DEBUG
```

**Type-safe configuration with `@ConfigurationProperties`:**

```java
@ConfigurationProperties(prefix = "app.payment")
public record PaymentProperties(
    String apiKey,
    String baseUrl,
    Duration timeout,
    int maxRetries
) {}
```

Enable with `@EnableConfigurationProperties(PaymentProperties.class)` on a config class, or annotate the record with `@Component`.

**Profile-specific config:** `application-local.yml`, `application-prod.yml`. Activate with `SPRING_PROFILES_ACTIVE=prod`.

---

## Part II: Web Layer (Spring MVC)

### REST Controllers

```java
@RestController
@RequestMapping("/api/v1/users")
@RequiredArgsConstructor  // Lombok — generates constructor injection
public class UserController {

    private final UserService userService;

    @GetMapping
    public List<UserResponse> listUsers(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        return userService.listUsers(page, size);
    }

    @GetMapping("/{id}")
    public UserResponse getUser(@PathVariable Long id) {
        return userService.getUser(id);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public UserResponse createUser(@Valid @RequestBody CreateUserRequest request) {
        return userService.createUser(request);
    }

    @PutMapping("/{id}")
    public UserResponse updateUser(@PathVariable Long id,
                                    @Valid @RequestBody UpdateUserRequest request) {
        return userService.updateUser(id, request);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteUser(@PathVariable Long id) {
        userService.deleteUser(id);
    }
}
```

**Key patterns:**
- Return DTOs, not entities. Use a mapper layer (MapStruct or manual).
- Use `@Valid` on request bodies to trigger Bean Validation.
- Use `@ResponseStatus` for non-200 success codes.
- Use `ResponseEntity<T>` when you need to control headers or conditional status codes.
- Paginate list endpoints — return `Page<T>` from Spring Data or accept `Pageable` parameter.

### Global Exception Handling

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ResourceNotFoundException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public ProblemDetail handleNotFound(ResourceNotFoundException ex) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
            HttpStatus.NOT_FOUND, ex.getMessage());
        problem.setTitle("Resource Not Found");
        return problem;
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ProblemDetail handleValidation(MethodArgumentNotValidException ex) {
        ProblemDetail problem = ProblemDetail.forStatus(HttpStatus.BAD_REQUEST);
        problem.setTitle("Validation Failed");
        Map<String, String> errors = new HashMap<>();
        ex.getBindingResult().getFieldErrors().forEach(err ->
            errors.put(err.getField(), err.getDefaultMessage()));
        problem.setProperty("fieldErrors", errors);
        return problem;
    }

    @ExceptionHandler(Exception.class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    public ProblemDetail handleGeneral(Exception ex) {
        // Log the full stack trace — never expose it to the client
        log.error("Unhandled exception", ex);
        return ProblemDetail.forStatusAndDetail(
            HttpStatus.INTERNAL_SERVER_ERROR, "An unexpected error occurred");
    }
}
```

Use **RFC 7807 ProblemDetail** (built into Spring 6+) for consistent error responses.

### Bean Validation

```java
public record CreateUserRequest(
    @NotBlank(message = "Username is required")
    @Size(min = 3, max = 50)
    String username,

    @NotBlank @Email
    String email,

    @NotBlank @Size(min = 8, message = "Password must be at least 8 characters")
    String password
) {}
```

Add `spring-boot-starter-validation` (included with `spring-boot-starter-web`). Use `@Valid` in controllers, `@Validated` on classes for method-parameter validation.

---

## Part III: Data Layer

For deep guidance on Spring Data JPA, JDBC, transaction management, and all supported data stores, read **`references/data-layer.md`**.

### Spring Data JPA Quick Reference

```java
@Entity
@Table(name = "users")
public class User {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String username;

    @Column(nullable = false)
    private String email;

    @CreationTimestamp
    @Column(updatable = false)
    private LocalDateTime createdAt;

    @UpdateTimestamp
    private LocalDateTime updatedAt;
}
```

```java
public interface UserRepository extends JpaRepository<User, Long> {
    Optional<User> findByUsername(String username);
    List<User> findByEmailContainingIgnoreCase(String email);
    boolean existsByUsername(String username);

    @Query("SELECT u FROM User u WHERE u.createdAt > :since")
    List<User> findRecentUsers(@Param("since") LocalDateTime since);

    @Modifying @Transactional
    @Query("UPDATE User u SET u.email = :email WHERE u.id = :id")
    int updateEmail(@Param("id") Long id, @Param("email") String email);
}
```

**Critical rules:**
- Set `spring.jpa.open-in-view=false` — OSIV causes lazy-loading surprises and connection leaks.
- Use `ddl-auto=validate` in production with Flyway or Liquibase for schema migrations.
- Use `@Transactional` on service methods, not on repositories or controllers.
- Watch for N+1 queries — use `JOIN FETCH` in JPQL or `@EntityGraph` annotations.

---

## Part IV: Security

For comprehensive Spring Security configuration, read **`references/security-guide.md`**.

### Minimal Security Configuration (Spring Security 6+)

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())  // Disable for stateless APIs
            .sessionManagement(session ->
                session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/v1/auth/**").permitAll()
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/v1/public/**").permitAll()
                .anyRequest().authenticated()
            )
            .oauth2ResourceServer(oauth2 ->
                oauth2.jwt(Customizer.withDefaults()));
        return http.build();
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
```

**Key principles:**
- Spring Security 6 uses the component-based `SecurityFilterChain` — no more `WebSecurityConfigurerAdapter`.
- Use lambda DSL for configuration: `.csrf(csrf -> csrf.disable())` not `.csrf().disable()`.
- For REST APIs: disable CSRF, use stateless sessions, authenticate via JWT/OAuth2.
- For server-rendered apps: keep CSRF enabled, use form login.
- Use `@PreAuthorize("hasRole('ADMIN')")` for method-level security.

---

## Part V: Testing

### Test Slice Annotations

| Annotation | What It Loads | When to Use |
|---|---|---|
| `@SpringBootTest` | Full application context | End-to-end integration tests |
| `@WebMvcTest(Controller.class)` | Web layer only (controllers, filters, advice) | Testing controllers in isolation |
| `@DataJpaTest` | JPA layer (repositories, entities, embedded DB) | Testing repositories |
| `@WebFluxTest` | Reactive web layer | Testing reactive controllers |
| `@JsonTest` | JSON serialisation/deserialisation | Testing DTO mapping |
| `@RestClientTest` | REST client infrastructure | Testing `RestTemplate`/`RestClient` |

### Testing Pattern Examples

```java
// Unit test — no Spring context, fast
@ExtendWith(MockitoExtension.class)
class UserServiceTest {
    @Mock UserRepository userRepository;
    @InjectMocks UserService userService;

    @Test
    void shouldThrowWhenUserNotFound() {
        when(userRepository.findById(1L)).thenReturn(Optional.empty());
        assertThrows(ResourceNotFoundException.class,
            () -> userService.getUser(1L));
    }
}
```

```java
// Web layer test — only loads the controller
@WebMvcTest(UserController.class)
class UserControllerTest {
    @Autowired MockMvc mockMvc;
    @MockBean UserService userService;

    @Test
    void shouldReturn200WhenUserExists() throws Exception {
        when(userService.getUser(1L)).thenReturn(new UserResponse(1L, "alice", "a@b.com"));
        mockMvc.perform(get("/api/v1/users/1"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.username").value("alice"));
    }
}
```

```java
// Repository test — auto-configures JPA with embedded H2
@DataJpaTest
class UserRepositoryTest {
    @Autowired UserRepository userRepository;

    @Test
    void shouldFindByUsername() {
        userRepository.save(new User(null, "alice", "a@b.com", null, null));
        Optional<User> found = userRepository.findByUsername("alice");
        assertThat(found).isPresent();
    }
}
```

```java
// Full integration test with Testcontainers
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
class OrderIntegrationTest {
    @Container
    static PostgreSQLContainer<?> postgres =
        new PostgreSQLContainer<>("postgres:16-alpine");

    @DynamicPropertySource
    static void configureDb(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    @Autowired TestRestTemplate restTemplate;

    @Test
    void shouldCreateAndRetrieveOrder() { /* ... */ }
}
```

---

## Part VI: Production Readiness

### Spring Boot Actuator

Add `spring-boot-starter-actuator`. Key endpoints:

| Endpoint | Purpose |
|---|---|
| `/actuator/health` | Liveness/readiness probes for Kubernetes |
| `/actuator/info` | Application info (build version, git commit) |
| `/actuator/metrics` | Micrometer metrics (JVM, HTTP, custom) |
| `/actuator/prometheus` | Prometheus-format metrics export |
| `/actuator/env` | Environment properties (sanitised) |
| `/actuator/loggers` | View/change log levels at runtime |

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  endpoint:
    health:
      show-details: when-authorized
      probes:
        enabled: true  # Kubernetes liveness/readiness
  metrics:
    tags:
      application: ${spring.application.name}
```

### Graceful Shutdown

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

### Structured Logging

```xml
<!-- logback-spring.xml -->
<configuration>
  <springProfile name="prod">
    <appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
      <encoder class="net.logstash.logback.encoder.LogstashEncoder"/>
    </appender>
    <root level="INFO"><appender-ref ref="JSON"/></root>
  </springProfile>
</configuration>
```

---

## Part VII: Complete Starter Reference

For the full catalogue of all official Spring Boot starters with descriptions, dependencies, key configuration properties, and usage patterns, read **`references/starter-catalogue.md`**.

The catalogue covers every official starter grouped by category:
- **Core** — base, test, devtools, configuration processor
- **Web** — web, webflux, websocket, hateoas, data-rest
- **Template Engines** — thymeleaf, freemarker, mustache, groovy-templates
- **Data** — data-jpa, data-jdbc, data-mongodb, data-redis, data-elasticsearch, data-cassandra, data-couchbase, data-neo4j, data-r2dbc, data-ldap, data-rest, jdbc, jooq
- **Security** — security, oauth2-client, oauth2-resource-server
- **Messaging** — amqp, artemis, integration, kafka (via spring-kafka), pulsar, websocket
- **I/O** — mail, validation, cache, quartz, batch
- **Observability** — actuator
- **Embedded Servers** — tomcat (default), jetty, undertow, reactor-netty
- **Logging** — logging (default/Logback), log4j2

---

## Reference Files

- **`references/data-layer.md`** — Deep guide to Spring Data JPA (entities, repositories, queries, specifications, auditing, pagination), Spring Data JDBC, JdbcTemplate, transaction management, Flyway/Liquibase migrations, connection pooling (HikariCP), N+1 query prevention, and all supported data stores (relational, MongoDB, Redis, Elasticsearch, Cassandra, etc.).

- **`references/security-guide.md`** — Comprehensive Spring Security 6 configuration: SecurityFilterChain, authentication (form, JWT, OAuth2, LDAP), authorisation (URL-based, method-level, ACL), CSRF/CORS, password encoding, custom UserDetailsService, testing with `@WithMockUser`, and production security hardening.

- **`references/starter-catalogue.md`** — Complete catalogue of all official Spring Boot starters with: Maven/Gradle coordinates, what each starter includes, key configuration properties, minimal usage examples, and guidance on when to use each one.
