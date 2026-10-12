# Spring Boot Official Starter Catalogue

Complete catalogue of all official Spring Boot starters provided by the Spring projects. Third-party starters (Camel, etc.) are out of scope.

## Table of Contents

1. [Core](#1-core)
2. [Web](#2-web)
3. [Template Engines](#3-template-engines)
4. [Data — Relational](#4-data--relational)
5. [Data — NoSQL](#5-data--nosql)
6. [Security](#6-security)
7. [Messaging](#7-messaging)
8. [I/O and Integration](#8-io-and-integration)
9. [Observability](#9-observability)
10. [Embedded Servers](#10-embedded-servers)
11. [Logging](#11-logging)

---

## 1. Core

### `spring-boot-starter`
The base starter. Includes auto-configuration, logging (Logback), and YAML support. Every other starter depends on this.

### `spring-boot-starter-test`
Testing dependencies: JUnit 5, Mockito, AssertJ, Hamcrest, JSONassert, JsonPath, Spring Test, Spring Boot Test.

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-test</artifactId>
    <scope>test</scope>
</dependency>
```

### `spring-boot-devtools`
Development-time features: automatic restart on code changes, LiveReload, relaxed property binding, H2 console auto-enable.

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-devtools</artifactId>
    <scope>runtime</scope>
    <optional>true</optional>
</dependency>
```

**Key properties:**
```yaml
spring.devtools.restart.enabled: true
spring.devtools.restart.additional-paths: src/main/java
spring.devtools.livereload.enabled: true
```

### `spring-boot-configuration-processor`
Generates metadata for `@ConfigurationProperties` classes, enabling IDE auto-completion.

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-configuration-processor</artifactId>
    <optional>true</optional>
</dependency>
```

### `spring-boot-docker-compose`
Auto-detects `compose.yaml` and starts Docker Compose services during development.

```yaml
spring.docker.compose:
  lifecycle-management: start-and-stop
  file: compose.yaml
```

---

## 2. Web

### `spring-boot-starter-web`
Full servlet-based web stack: Spring MVC, embedded Tomcat, Jackson JSON, Bean Validation, multipart file uploads.

**Includes:** `spring-boot-starter`, `spring-boot-starter-json`, `spring-boot-starter-tomcat`, `spring-web`, `spring-webmvc`

**Key properties:**
```yaml
server.port: 8080
server.servlet.context-path: /
server.compression.enabled: true
server.compression.mime-types: application/json,text/html
spring.mvc.throw-exception-if-no-handler-found: true
spring.web.resources.add-mappings: false  # For API-only apps
```

### `spring-boot-starter-webflux`
Reactive web stack: Spring WebFlux, Reactor Netty, reactive JSON encoding.

**When to use:** Non-blocking I/O, high-concurrency services, streaming responses, reactive data sources (R2DBC, reactive MongoDB).

```java
@RestController
public class UserController {
    @GetMapping("/users")
    public Flux<User> getUsers() {
        return userService.findAll();
    }

    @GetMapping("/users/{id}")
    public Mono<User> getUser(@PathVariable String id) {
        return userService.findById(id);
    }
}
```

### `spring-boot-starter-websocket`
WebSocket support: STOMP messaging, SockJS fallback.

```java
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {
    @Override
    public void configureMessageBroker(MessageBrokerRegistry config) {
        config.enableSimpleBroker("/topic");
        config.setApplicationDestinationPrefixes("/app");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws").withSockJS();
    }
}
```

### `spring-boot-starter-hateoas`
Hypermedia-driven REST APIs: `RepresentationModel`, `EntityModel`, `CollectionModel`, link building.

```java
@GetMapping("/api/users/{id}")
public EntityModel<UserResponse> getUser(@PathVariable Long id) {
    UserResponse user = userService.getUser(id);
    return EntityModel.of(user,
        linkTo(methodOn(UserController.class).getUser(id)).withSelfRel(),
        linkTo(methodOn(UserController.class).listUsers(0, 20)).withRel("users"));
}
```

### `spring-boot-starter-data-rest`
Automatically exposes Spring Data repositories as REST endpoints. Useful for rapid prototyping.

```java
@RepositoryRestResource(path = "users")
public interface UserRepository extends JpaRepository<User, Long> {}
// Automatically creates GET/POST/PUT/DELETE /users endpoints
```

**Key properties:**
```yaml
spring.data.rest:
  base-path: /api
  default-page-size: 20
  return-body-on-create: true
```

### `spring-boot-starter-json`
Jackson JSON serialisation (included by `starter-web`). Auto-configures `ObjectMapper`.

**Key properties:**
```yaml
spring.jackson:
  date-format: yyyy-MM-dd'T'HH:mm:ss.SSSZ
  serialization.write-dates-as-timestamps: false
  deserialization.fail-on-unknown-properties: false
  default-property-inclusion: non_null
```

### `spring-boot-starter-validation`
Bean Validation (Hibernate Validator): `@NotNull`, `@NotBlank`, `@Size`, `@Email`, `@Min`, `@Max`, `@Pattern`, `@Valid`, `@Validated`.

---

## 3. Template Engines

### `spring-boot-starter-thymeleaf`
Server-side HTML rendering. Natural templates that render in browsers without a server.

**Key properties:**
```yaml
spring.thymeleaf:
  cache: false  # Disable in development
  prefix: classpath:/templates/
  suffix: .html
```

### `spring-boot-starter-freemarker`
Apache FreeMarker template engine.

### `spring-boot-starter-mustache`
Logic-less Mustache templates. Minimal, fast, and simple.

### `spring-boot-starter-groovy-templates`
Groovy markup template engine.

---

## 4. Data — Relational

### `spring-boot-starter-data-jpa`
Spring Data JPA + Hibernate ORM. Auto-configures `EntityManagerFactory`, `DataSource`, `TransactionManager`.

**See:** `data-layer.md` for comprehensive guidance.

### `spring-boot-starter-data-jdbc`
Spring Data JDBC — simpler, more explicit alternative to JPA. No lazy loading, no caching, no proxy magic.

### `spring-boot-starter-jdbc`
Raw JDBC: `JdbcTemplate`, `JdbcClient` (Spring 6.1+), `DataSource` auto-configuration, HikariCP connection pool.

### `spring-boot-starter-jooq`
jOOQ — type-safe SQL via code generation from your database schema.

```java
// jOOQ-generated code ensures compile-time SQL safety
dsl.select(USERS.NAME, USERS.EMAIL)
   .from(USERS)
   .where(USERS.STATUS.eq("ACTIVE"))
   .fetch();
```

### `spring-boot-starter-data-r2dbc`
Reactive relational database connectivity. For non-blocking database access with WebFlux.

```yaml
spring.r2dbc:
  url: r2dbc:postgresql://localhost:5432/mydb
  username: postgres
  password: postgres
```

---

## 5. Data — NoSQL

### `spring-boot-starter-data-mongodb`
Spring Data MongoDB: `MongoRepository`, `MongoTemplate`, auto-configured `MongoClient`.

```yaml
spring.data.mongodb:
  uri: mongodb://localhost:27017/mydb
  # or
  host: localhost
  port: 27017
  database: mydb
```

### `spring-boot-starter-data-mongodb-reactive`
Reactive MongoDB: `ReactiveMongoRepository`, `ReactiveMongoTemplate`.

### `spring-boot-starter-data-redis`
Spring Data Redis: `RedisTemplate`, `StringRedisTemplate`, repository support.

```yaml
spring.data.redis:
  host: localhost
  port: 6379
  password: ${REDIS_PASSWORD:}
  timeout: 2000ms
  lettuce:
    pool:
      max-active: 10
      max-idle: 5
```

### `spring-boot-starter-data-redis-reactive`
Reactive Redis with Lettuce.

### `spring-boot-starter-data-elasticsearch`
Spring Data Elasticsearch: `ElasticsearchRepository`, `ElasticsearchOperations`.

```yaml
spring.elasticsearch:
  uris: http://localhost:9200
  username: elastic
  password: ${ES_PASSWORD:}
```

### `spring-boot-starter-data-cassandra`
Spring Data Cassandra: `CassandraRepository`, `CassandraTemplate`.

### `spring-boot-starter-data-cassandra-reactive`
Reactive Cassandra.

### `spring-boot-starter-data-couchbase`
Spring Data Couchbase: `CouchbaseRepository`.

### `spring-boot-starter-data-couchbase-reactive`
Reactive Couchbase.

### `spring-boot-starter-data-neo4j`
Spring Data Neo4j: `Neo4jRepository` for graph databases.

### `spring-boot-starter-data-ldap`
Spring Data LDAP: `LdapRepository` for directory services.

---

## 6. Security

### `spring-boot-starter-security`
Spring Security: authentication, authorisation, CSRF, CORS, session management, security headers.

**See:** `security-guide.md` for comprehensive configuration.

### `spring-boot-starter-oauth2-client`
OAuth2/OpenID Connect client: login via Google, GitHub, Keycloak, Okta, etc.

### `spring-boot-starter-oauth2-resource-server`
OAuth2 resource server: validate incoming JWT or opaque tokens.

### `spring-boot-starter-oauth2-authorization-server`
Build your own OAuth2 authorization server (Spring Authorization Server project).

---

## 7. Messaging

### `spring-boot-starter-amqp`
Spring AMQP with RabbitMQ: `RabbitTemplate`, `@RabbitListener`, auto-configured `ConnectionFactory`.

```yaml
spring.rabbitmq:
  host: localhost
  port: 5672
  username: guest
  password: guest
```

```java
@RabbitListener(queues = "orders")
public void handleOrder(OrderEvent event) {
    orderService.process(event);
}
```

### `spring-boot-starter-artemis`
Apache ActiveMQ Artemis (JMS): `JmsTemplate`, `@JmsListener`.

```yaml
spring.artemis:
  mode: native
  broker-url: tcp://localhost:61616
```

### `spring-boot-starter-integration`
Spring Integration: enterprise integration patterns (EIP) — channels, transformers, routers, adapters, gateways.

### Spring Kafka (`spring-kafka`)
Apache Kafka support. Not a `spring-boot-starter-*` but auto-configured by Spring Boot when on classpath.

```yaml
spring.kafka:
  bootstrap-servers: localhost:9092
  consumer:
    group-id: my-group
    auto-offset-reset: earliest
    key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
    value-deserializer: org.springframework.kafka.support.serializer.JsonDeserializer
  producer:
    key-serializer: org.apache.kafka.common.serialization.StringSerializer
    value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
```

```java
@KafkaListener(topics = "orders", groupId = "order-processor")
public void consume(OrderEvent event) { /* ... */ }

kafkaTemplate.send("orders", event);
```

### Spring Pulsar (`spring-boot-starter-pulsar`)
Apache Pulsar messaging support.

---

## 8. I/O and Integration

### `spring-boot-starter-mail`
Email sending: `JavaMailSender`, auto-configured from SMTP properties.

```yaml
spring.mail:
  host: smtp.gmail.com
  port: 587
  username: ${MAIL_USER}
  password: ${MAIL_PASS}
  properties:
    mail.smtp.auth: true
    mail.smtp.starttls.enable: true
```

```java
@Autowired JavaMailSender mailSender;

SimpleMailMessage message = new SimpleMailMessage();
message.setTo("user@example.com");
message.setSubject("Welcome");
message.setText("Hello, welcome to our platform!");
mailSender.send(message);
```

### `spring-boot-starter-cache`
Cache abstraction: `@Cacheable`, `@CacheEvict`, `@CachePut`. Works with Caffeine, EhCache, Redis, Hazelcast.

```java
@Configuration
@EnableCaching
public class CacheConfig {}

@Service
public class ProductService {
    @Cacheable(value = "products", key = "#id")
    public Product getProduct(Long id) { /* expensive lookup */ }

    @CacheEvict(value = "products", key = "#id")
    public void updateProduct(Long id, UpdateRequest req) { /* ... */ }

    @CacheEvict(value = "products", allEntries = true)
    public void clearProductCache() {}
}
```

```yaml
spring.cache:
  type: caffeine  # or redis, ehcache, hazelcast
  caffeine.spec: maximumSize=500,expireAfterWrite=10m
```

### `spring-boot-starter-quartz`
Quartz job scheduler: cron-based and interval-based job scheduling with persistence.

```java
@Component
public class ReportJob extends QuartzJobBean {
    @Override
    protected void executeInternal(JobExecutionContext context) {
        reportService.generateDailyReport();
    }
}
```

### `spring-boot-starter-batch`
Spring Batch: chunk-based and tasklet processing for ETL, data migration, report generation.

```java
@Configuration
public class BatchConfig {
    @Bean
    public Job importJob(JobRepository jobRepository, Step step1) {
        return new JobBuilder("importJob", jobRepository)
            .start(step1)
            .build();
    }

    @Bean
    public Step step1(JobRepository jobRepository,
                      PlatformTransactionManager txManager) {
        return new StepBuilder("step1", jobRepository)
            .<InputRecord, OutputRecord>chunk(100, txManager)
            .reader(reader())
            .processor(processor())
            .writer(writer())
            .build();
    }
}
```

### `spring-boot-starter-aop`
Aspect-Oriented Programming: `@Aspect`, `@Before`, `@After`, `@Around`. For cross-cutting concerns like logging, metrics, security.

```java
@Aspect @Component
public class LoggingAspect {
    @Around("@annotation(com.example.Loggable)")
    public Object logExecution(ProceedingJoinPoint joinPoint) throws Throwable {
        long start = System.currentTimeMillis();
        Object result = joinPoint.proceed();
        log.info("{} executed in {}ms",
            joinPoint.getSignature().getName(),
            System.currentTimeMillis() - start);
        return result;
    }
}
```

### Scheduling (built-in)

No separate starter needed — just `@EnableScheduling`:

```java
@Configuration
@EnableScheduling
public class ScheduleConfig {}

@Component
public class ScheduledTasks {
    @Scheduled(fixedRate = 60000)  // Every 60 seconds
    public void cleanExpiredTokens() { /* ... */ }

    @Scheduled(cron = "0 0 2 * * *")  // Daily at 2 AM
    public void generateReport() { /* ... */ }
}
```

### REST Clients (built-in to spring-boot-starter-web)

**RestClient (Spring 6.1+, recommended):**
```java
RestClient restClient = RestClient.builder()
    .baseUrl("https://api.example.com")
    .defaultHeader("Authorization", "Bearer " + token)
    .build();

UserResponse user = restClient.get()
    .uri("/users/{id}", userId)
    .retrieve()
    .body(UserResponse.class);
```

**Declarative HTTP Interface (Spring 6.0+):**
```java
public interface UserClient {
    @GetExchange("/users/{id}")
    UserResponse getUser(@PathVariable Long id);

    @PostExchange("/users")
    UserResponse createUser(@RequestBody CreateUserRequest request);
}
```

---

## 9. Observability

### `spring-boot-starter-actuator`
Production monitoring: health checks, metrics (Micrometer), info endpoint, loggers, environment.

**See:** Part VI of SKILL.md for configuration.

Metrics export targets (add corresponding dependency):
- Prometheus (`micrometer-registry-prometheus`)
- Datadog (`micrometer-registry-datadog`)
- New Relic (`micrometer-registry-new-relic`)
- CloudWatch (`micrometer-registry-cloudwatch2`)

---

## 10. Embedded Servers

### `spring-boot-starter-tomcat` (default)
Included by `spring-boot-starter-web`. Apache Tomcat.

### `spring-boot-starter-jetty`
Eclipse Jetty. Swap by excluding Tomcat:
```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
    <exclusions>
        <exclusion>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-tomcat</artifactId>
        </exclusion>
    </exclusions>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-jetty</artifactId>
</dependency>
```

### `spring-boot-starter-undertow`
JBoss Undertow. Same exclusion pattern as Jetty.

### `spring-boot-starter-reactor-netty`
Included by `spring-boot-starter-webflux`. Reactor Netty for reactive applications.

---

## 11. Logging

### `spring-boot-starter-logging` (default)
Logback + SLF4J. Included automatically by `spring-boot-starter`.

```yaml
logging:
  level:
    root: INFO
    com.example: DEBUG
    org.springframework.web: INFO
    org.hibernate.SQL: DEBUG
  file:
    name: app.log
    path: /var/log/myapp
  pattern:
    console: "%d{HH:mm:ss} %-5level [%thread] %logger{36} - %msg%n"
```

### `spring-boot-starter-log4j2`
Apache Log4j2 as alternative to Logback. Exclude `spring-boot-starter-logging` first.
