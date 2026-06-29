FROM eclipse-temurin:17-jdk-alpine AS build
WORKDIR /app
COPY src ./src
RUN javac -d out src/main/java/com/example/App.java

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /app/out /app
EXPOSE 8080
CMD ["java", "com.example.App"]
