-- run with: npm run demo

-- the five customers who have spent the most
SELECT c.name, c.country, COUNT(*) AS orders, ROUND(SUM(o.quantity * p.price), 2) AS spent
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products p ON o.product_id = p.id
WHERE o.status <> 'cancelled'
GROUP BY c.id, c.name, c.country
ORDER BY spent DESC
LIMIT 5;

-- what each category brings in
SELECT p.category, COUNT(*) AS orders, ROUND(SUM(o.quantity * p.price), 2) AS revenue
FROM orders o JOIN products p ON o.product_id = p.id
WHERE o.status = 'delivered'
GROUP BY p.category
ORDER BY revenue DESC;

-- COUNT(column) skips nulls: orders that were never sent have no shipped_on
SELECT status, COUNT(*) AS orders, COUNT(shipped_on) AS sent
FROM orders
GROUP BY status
ORDER BY orders DESC;

-- customers who have never ordered, found with a left join
SELECT c.country, COUNT(*) AS never_ordered
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.id IS NULL
GROUP BY c.country
ORDER BY never_ordered DESC, c.country
LIMIT 3;

-- how the first query is run
EXPLAIN
SELECT c.name, c.country, COUNT(*) AS orders, ROUND(SUM(o.quantity * p.price), 2) AS spent
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products p ON o.product_id = p.id
WHERE o.status <> 'cancelled'
GROUP BY c.id, c.name, c.country
ORDER BY spent DESC
LIMIT 5;
