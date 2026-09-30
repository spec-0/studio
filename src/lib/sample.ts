/**
 * The spec that ships with the app, so a first run has something to explore
 * instead of an empty drop zone.
 *
 * Written to exercise the things Studio is actually for: several tags, typed
 * parameters with enums, a request body worth generating, composed schemas, and a
 * deliberate `Customer → Order → Customer` cycle so the graph has to prove it
 * terminates.
 */
export const SAMPLE_NAME = "Orders API (sample)";

export const SAMPLE_SPEC = `openapi: 3.0.3
info:
  title: Orders API (sample)
  version: 1.4.0
  description: |
    A small, made-up commerce API bundled with spec0 Studio so there's something
    to explore on a first run. Nothing here is real. Point the base URL at your
    own service, or open one of your specs.
servers:
  - url: https://api.example.com/v1
    description: Production
  - url: https://staging.api.example.com/v1
    description: Staging
tags:
  - name: Orders
  - name: Customers
paths:
  /orders:
    get:
      operationId: listOrders
      tags: [Orders]
      summary: List orders
      description: Orders are returned newest first. Use \`cursor\` to page.
      parameters:
        - name: status
          in: query
          description: Only return orders in this state.
          schema:
            type: string
            enum: [pending, paid, shipped, cancelled]
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
        - name: cursor
          in: query
          schema: { type: string }
      responses:
        '200':
          description: A page of orders
          content:
            application/json:
              schema:
                type: object
                required: [data]
                properties:
                  data:
                    type: array
                    items: { $ref: '#/components/schemas/Order' }
                  nextCursor: { type: string, nullable: true }
        '401': { $ref: '#/components/responses/Problem' }
    post:
      operationId: createOrder
      tags: [Orders]
      summary: Create an order
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/NewOrder' }
      responses:
        '201':
          description: The created order
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
        '422': { $ref: '#/components/responses/Problem' }
  /orders/{orderId}:
    get:
      operationId: getOrder
      tags: [Orders]
      summary: Get one order
      parameters:
        - name: orderId
          in: path
          required: true
          schema: { type: string, format: uuid }
      responses:
        '200':
          description: The order
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
        '404': { $ref: '#/components/responses/Problem' }
  /customers/{customerId}:
    get:
      operationId: getCustomer
      tags: [Customers]
      summary: Get one customer
      parameters:
        - name: customerId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: The customer
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Customer' }
        '404': { $ref: '#/components/responses/Problem' }
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      description: Use an environment variable, e.g. {{token}}
  responses:
    Problem:
      description: Something went wrong
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Problem' }
  schemas:
    Order:
      type: object
      description: A customer's order.
      required: [id, status, customer, lineItems, total]
      properties:
        id: { type: string, format: uuid }
        status:
          type: string
          enum: [pending, paid, shipped, cancelled]
        placedAt: { type: string, format: date-time }
        customer: { $ref: '#/components/schemas/Customer' }
        lineItems:
          type: array
          items: { $ref: '#/components/schemas/LineItem' }
        total: { $ref: '#/components/schemas/Money' }
        shippingAddress: { $ref: '#/components/schemas/Address' }
    NewOrder:
      type: object
      description: What you send to create an order.
      required: [customerId, lineItems]
      properties:
        customerId: { type: string }
        lineItems:
          type: array
          minItems: 1
          items: { $ref: '#/components/schemas/LineItem' }
        shippingAddress: { $ref: '#/components/schemas/Address' }
        note: { type: string, description: Free text shown on the packing slip. }
    LineItem:
      type: object
      required: [sku, quantity, unitPrice]
      properties:
        sku: { type: string }
        description: { type: string }
        quantity: { type: integer, minimum: 1 }
        unitPrice: { $ref: '#/components/schemas/Money' }
    Customer:
      type: object
      required: [id, email]
      properties:
        id: { type: string }
        email: { type: string, format: email }
        firstName: { type: string }
        lastName: { type: string }
        billingAddress: { $ref: '#/components/schemas/Address' }
        # Deliberate cycle: Customer -> Order -> Customer.
        recentOrders:
          type: array
          items: { $ref: '#/components/schemas/Order' }
    Address:
      type: object
      required: [line1, city, country]
      properties:
        line1: { type: string }
        line2: { type: string, nullable: true }
        city: { type: string }
        postalCode: { type: string }
        country: { type: string, description: ISO 3166-1 alpha-2. }
    Money:
      type: object
      required: [amount, currency]
      properties:
        amount: { type: integer, description: Minor units (1999 is 19.99). }
        currency: { type: string, enum: [USD, EUR, GBP] }
    Problem:
      type: object
      required: [title, status]
      properties:
        type: { type: string, format: uri }
        title: { type: string }
        status: { type: integer }
        detail: { type: string }
`;
