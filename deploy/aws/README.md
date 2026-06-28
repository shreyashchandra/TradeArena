# AWS Deployment Notes

This folder contains ECS/Fargate task-definition scaffolding. To deploy for real:

1. Create ECR repositories for backend, gateway, and frontend.
2. Build and push Docker images.
3. Replace `<account-id>` and `<region>` in `ecs-task-definition.json`.
4. Create an ECS cluster, service, target group, and application load balancer.
5. Move PostgreSQL to RDS and Redis to ElastiCache.
6. Store secrets in AWS Secrets Manager or SSM Parameter Store.
7. Add CloudWatch alarms for 5xx rate, latency, CPU, memory, and task restarts.

This repo cannot deploy AWS resources without your AWS account, IAM role, VPC,
subnets, and domain configuration.
