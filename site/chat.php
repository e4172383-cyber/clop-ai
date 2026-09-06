<?php
// Прокси браузер -> локальный сервер с Claude. Ключ добавляется здесь,
// на стороне сервера хостинга, посетитель сайта его никогда не видит.
require __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'method not allowed']);
    exit;
}

$raw = file_get_contents('php://input');
$data = json_decode($raw, true);
$message = isset($data['message']) ? trim((string)$data['message']) : '';
$sessionId = isset($data['sessionId']) ? (string)$data['sessionId'] : null;

if ($message === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'message is required']);
    exit;
}

$payload = json_encode(['message' => $message, 'sessionId' => $sessionId]);

$ch = curl_init(BACKEND_URL);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'x-site-key: ' . SITE_KEY,
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 120,
]);
$response = curl_exec($ch);
$err = curl_error($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($response === false) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'backend unreachable: ' . $err]);
    exit;
}

http_response_code($code ?: 200);
echo $response;
