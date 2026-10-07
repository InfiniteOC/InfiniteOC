# Data Layer: Spring Data, JPA, JDBC, and Transactions

## Table of Contents

1. [Spring Data JPA](#1-spring-data-jpa)
2. [Entity Mapping](#2-entity-mapping)
3. [Repository Queries](#3-repository-queries)
4. [Transaction Management](#4-transaction-management)
5. [N+1 Query Prevention](#5-n1-query-prevention)
6. [Pagination and Sorting](#6-pagination-and-sorting)
7. [Auditing](#7-auditing)
8. [Specifications (Dynamic Queries)](#8-specifications-dynamic-queries)
9. [Spring Data JDBC](#9-spring-data-jdbc)
10. [JdbcTemplate and JdbcClient](#10-jdbctemplate-and-jdbcclient)
11. [Schema Migrations](#11-schema-migrations)
12. [Connection Pooling](#12-connection-pooling)
13. [NoSQL Data Stores](#13-nosql-data-stores)

---

## 1. Spring Data JPA

**Starter:** `spring-boot-starter-data-jpa`

Provides repository abstraction over JPA/Hibernate. Auto-configures `EntityManagerFactory`, `DataSource`, and transaction manager.

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/mydb
    username: ${DB_USER:postgres}
    password: ${DB_PASS:postgres}
    hikari:
      maximum-pool-size: 10
      minimum-idle: 5
      connection-timeout: 30000
  jpa:
    open-in-view: false            # Always disable in production
    hibernate:
      ddl-auto: validate           # validate in prod, update only in dev
    properties:
      hibernate:
        default_batch_fetch_size: 16
        jdbc.batch_size: 25
        order_inserts: true
        order_updates: true
        format_sql: true
    show-sql: false                # Use logging.level.org.hibernate.SQL=DEBUG instead
```

---

## 2. Entity Mapping

```java
@Entity
@Table(name = "orders", indexes = {
    @Index(name = "idx_order_customer", columnList = "customer_id"),
    @Index(name = "idx_order_status", columnList = "status")
})
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String orderNumber;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private OrderStatus status;

    @ManyToOne(fetch = FetchType.LAZY)  // Always use LAZY for @ManyToOne
    @JoinColumn(name = "customer_id", nullable = false)
    private Customer customer;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderItem> items = new ArrayList<>();

    @CreationTimestamp
    @Column(updatable = false)
    private LocalDateTime createdAt;

    @UpdateTimestamp
    private LocalDateTime updatedAt;

    // Helper method for bidirectional association
    public void addItem(OrderItem item) {
        items.add(item);
        item.setOrder(this);
    }
}
```

**Entity rules:**
- **Always** set `@ManyToOne(fetch = FetchType.LAZY)`. The JPA default (`EAGER`) causes N+1 problems.
- `@OneToMany` is `LAZY` by default — leave it that way.
- Use `@Enumerated(EnumType.STRING)` — `ORDINAL` breaks when you reorder enum values.
- Use `GenerationType.IDENTITY` for PostgreSQL/MySQL. Use `SEQUENCE` for Oracle or when batch inserts are critical.
- Add bidirectional helper methods to keep both sides of associations in sync.
- Prefer `mappedBy` on the non-owning side to avoid extra update statements.

### Embeddables

```java
@Embeddable
public record Address(
    String street,
    String city,
    String state,
    @Column(name = "zip_code") String zipCode
) {}

@Entity
public class Customer {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Embedded
    private Address address;
}
```

---

## 3. Repository Queries

### Derived Query Methods

Spring Data generates SQL from method names:

```java
public interface ProductRepository extends JpaRepository<Product, Long> {
    // WHERE name = ?
    Optional<Product> findByName(String name);

    // WHERE price BETWEEN ? AND ?
    List<Product> findByPriceBetween(BigDecimal min, BigDecimal max);

    // WHERE category = ? AND active = true ORDER BY name ASC
    List<Product> findByCategoryAndActiveTrueOrderByNameAsc(String category);

    // WHERE name LIKE %?%  (case-insensitive)
    Page<Product> findByNameContainingIgnoreCase(String name, Pageable pageable);

    // COUNT WHERE category = ?
    long countByCategory(String category);

    // EXISTS WHERE sku = ?
    boolean existsBySku(String sku);

    // DELETE WHERE expiredAt < ?
    @Transactional
    void deleteByExpiredAtBefore(LocalDateTime date);
}
```

**Naming convention keywords:** `And`, `Or`, `Between`, `LessThan`, `GreaterThan`, `Like`, `Containing`, `In`, `OrderBy`, `Not`, `IsNull`, `IsNotNull`, `True`, `False`, `IgnoreCase`, `Before`, `After`, `StartingWith`, `EndingWith`.

### JPQL Queries

```java
@Query("SELECT p FROM Product p WHERE p.category = :cat AND p.price < :maxPrice")
List<Product> findAffordableByCategory(@Param("cat") String category,
                                       @Param("maxPrice") BigDecimal maxPrice);

@Query("SELECT new com.example.dto.ProductSummary(p.id, p.name, p.price) " +
       "FROM Product p WHERE p.active = true")
List<ProductSummary> findActiveProductSummaries();
```

### Native Queries

```java
@Query(value = "SELECT * FROM products WHERE tsv @@ to_tsquery(:query)",
       nativeQuery = true)
List<Product> fullTextSearch(@Param("query") String query);
```

### Modifying Queries

```java
@Modifying(clearAutomatically = true)
@Transactional
@Query("UPDATE Product p SET p.price = p.price * :factor WHERE p.category = :cat")
int adjustPriceByCategory(@Param("cat") String category,
                          @Param("factor") BigDecimal factor);
```

Always use `clearAutomatically = true` with `@Modifying` to keep the persistence context in sync.

---

## 4. Transaction Management

```java
@Service
@Transactional(readOnly = true)  // Default for the class: read-only transactions
public class OrderService {

    private final OrderRepository orderRepository;

    public OrderService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    // Inherits class-level read-only transaction
    public OrderResponse getOrder(Long id) {
        return orderRepository.findById(id)
            .map(OrderMapper::toResponse)
            .orElseThrow(() -> new ResourceNotFoundException("Order", id));
    }

    @Transactional  // Overrides to read-write for mutations
    public OrderResponse createOrder(CreateOrderRequest request) {
        Order order = OrderMapper.toEntity(request);
        order = orderRepository.save(order);
        return OrderMapper.toResponse(order);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void logAuditEvent(AuditEvent event) {
        // Runs in a separate transaction — committed even if caller rolls back
        auditRepository.save(event);
    }
}
```

**Transaction rules:**
- Place `@Transactional` on **service methods**, not repositories or controllers.
- Use `readOnly = true` for queries — enables Hibernate flush-mode optimisations and read-replicas.
- Default propagation (`REQUIRED`) joins an existing transaction or starts a new one.
- `REQUIRES_NEW` starts a fresh transaction — use for audit logging or operations that must commit independently.
- `@Transactional` only works on **public** methods called from **outside** the class (Spring AOP proxy limitation).
- Declare checked exceptions in `rollbackFor` if you need rollback on checked exceptions: `@Transactional(rollbackFor = Exception.class)`.

### Propagation Levels

| Level | Behaviour |
|---|---|
| `REQUIRED` (default) | Join existing or start new |
| `REQUIRES_NEW` | Always start new (suspend existing) |
| `SUPPORTS` | Join if exists, otherwise non-transactional |
| `NOT_SUPPORTED` | Suspend existing, run non-transactional |
| `MANDATORY` | Must have existing — throw if none |
| `NEVER` | Must not have existing — throw if one exists |
| `NESTED` | Nested transaction with savepoint (JDBC only) |

---

## 5. N+1 Query Prevention

The most common performance problem in JPA applications. When you load a list of entities and then access a lazy association on each one, JPA fires one query per entity.

### Detection

Enable SQL logging in development:
```yaml
logging.level.org.hibernate.SQL: DEBUG
logging.level.org.hibernate.orm.jdbc.bind: TRACE  # See bind parameters
```

### Solutions

**JOIN FETCH in JPQL:**
```java
@Query("SELECT o FROM Order o JOIN FETCH o.customer JOIN FETCH o.items WHERE o.status = :status")
List<Order> findByStatusWithDetails(@Param("status") OrderStatus status);
```

**@EntityGraph:**
```java
@EntityGraph(attributePaths = {"customer", "items"})
List<Order> findByStatus(OrderStatus status);
```

**Batch Fetching (global):**
```yaml
spring.jpa.properties.hibernate.default_batch_fetch_size: 16
```

This changes N+1 into N/16+1 queries by loading lazy associations in batches.

**Projection DTOs (best for read-only use cases):**
```java
@Query("SELECT new com.example.dto.OrderSummary(o.id, o.orderNumber, c.name) " +
       "FROM Order o JOIN o.customer c WHERE o.status = :status")
List<OrderSummary> findOrderSummaries(@Param("status") OrderStatus status);
```

Projections avoid loading full entities and their associations entirely.

---

## 6. Pagination and Sorting

```java
// In repository
Page<Product> findByCategory(String category, Pageable pageable);

// In service
Pageable pageable = PageRequest.of(0, 20, Sort.by("name").ascending());
Page<Product> page = productRepository.findByCategory("electronics", pageable);
// page.getContent(), page.getTotalElements(), page.getTotalPages(), page.hasNext()

// In controller — Spring auto-resolves Pageable from query params
@GetMapping
public Page<ProductResponse> listProducts(
        @RequestParam(required = false) String category,
        Pageable pageable) {  // ?page=0&size=20&sort=name,asc
    return productService.listProducts(category, pageable);
}
```

---

## 7. Auditing

```java
@Configuration
@EnableJpaAuditing
public class JpaConfig {}

@MappedSuperclass
@EntityListeners(AuditingEntityListener.class)
public abstract class Auditable {
    @CreatedDate @Column(updatable = false)
    private LocalDateTime createdAt;

    @LastModifiedDate
    private LocalDateTime updatedAt;

    @CreatedBy @Column(updatable = false)
    private String createdBy;

    @LastModifiedBy
    private String updatedBy;
}
```

Implement `AuditorAware<String>` to provide the current user from `SecurityContextHolder`.

---

## 8. Specifications (Dynamic Queries)

For complex search/filter scenarios where query methods would be unwieldy:

```java
public interface ProductRepository extends JpaRepository<Product, Long>,
                                           JpaSpecificationExecutor<Product> {}

public class ProductSpecifications {
    public static Specification<Product> hasCategory(String category) {
        return (root, query, cb) ->
            category == null ? null : cb.equal(root.get("category"), category);
    }

    public static Specification<Product> priceBetween(BigDecimal min, BigDecimal max) {
        return (root, query, cb) ->
            cb.between(root.get("price"), min, max);
    }
}

// Usage
Specification<Product> spec = Specification
    .where(ProductSpecifications.hasCategory(filterCategory))
    .and(ProductSpecifications.priceBetween(minPrice, maxPrice));
Page<Product> results = productRepository.findAll(spec, pageable);
```

---

## 9. Spring Data JDBC

Lighter alternative to JPA — no lazy loading, no dirty checking, no session cache. Better for simpler domain models and when you want explicit control.

**Starter:** `spring-boot-starter-data-jdbc`

```java
// No @Entity — uses @Table and @Id from Spring Data
@Table("products")
public class Product {
    @Id private Long id;
    private String name;
    private BigDecimal price;
}

public interface ProductRepository extends CrudRepository<Product, Long> {
    @Query("SELECT * FROM products WHERE category = :category")
    List<Product> findByCategory(String category);
}
```

---

## 10. JdbcTemplate and JdbcClient

For raw SQL when ORM is overkill:

```java
// Modern JdbcClient (Spring 6.1+)
@Repository
public class ReportRepository {
    private final JdbcClient jdbcClient;

    public ReportRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    public List<SalesReport> getMonthlySales(int year) {
        return jdbcClient.sql("""
                SELECT month, SUM(amount) as total
                FROM orders
                WHERE EXTRACT(YEAR FROM created_at) = :year
                GROUP BY month ORDER BY month
                """)
            .param("year", year)
            .query(SalesReport.class)
            .list();
    }
}
```

---

## 11. Schema Migrations

**Always** use migration tools in production — never `ddl-auto=update`.

### Flyway (recommended)

**Starter:** `spring-boot-starter-data-jpa` auto-detects Flyway if on classpath.

```xml
<dependency>
    <groupId>org.flywaydb</groupId>
    <artifactId>flyway-core</artifactId>
</dependency>
```

Place SQL files in `src/main/resources/db/migration/`:

```
V1__create_users_table.sql
V2__add_email_column.sql
V3__create_orders_table.sql
```

```yaml
spring.flyway:
  enabled: true
  locations: classpath:db/migration
  baseline-on-migrate: true  # For existing databases
```

### Liquibase

```xml
<dependency>
    <groupId>org.liquibase</groupId>
    <artifactId>liquibase-core</artifactId>
</dependency>
```

---

## 12. Connection Pooling

Spring Boot uses HikariCP by default. Key tuning properties:

```yaml
spring.datasource.hikari:
  maximum-pool-size: 10          # Connections = (CPU cores * 2) + spindle count
  minimum-idle: 5
  connection-timeout: 30000      # 30 seconds
  idle-timeout: 600000           # 10 minutes
  max-lifetime: 1800000          # 30 minutes
  leak-detection-threshold: 60000 # Warn if connection held > 60s
```

---

## 13. NoSQL Data Stores

| Store | Starter | Repository Interface |
|---|---|---|
| MongoDB | `spring-boot-starter-data-mongodb` | `MongoRepository` |
| Redis | `spring-boot-starter-data-redis` | `CrudRepository` + `RedisTemplate` |
| Elasticsearch | `spring-boot-starter-data-elasticsearch` | `ElasticsearchRepository` |
| Cassandra | `spring-boot-starter-data-cassandra` | `CassandraRepository` |
| Couchbase | `spring-boot-starter-data-couchbase` | `CouchbaseRepository` |
| Neo4j | `spring-boot-starter-data-neo4j` | `Neo4jRepository` |

Each follows the same Spring Data repository pattern — define an interface, Spring provides the implementation.
