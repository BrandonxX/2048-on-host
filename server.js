require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(helmet());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Database connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME || 'mydatabase',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test database connection
async function testDbConnection() {
    try {
        const conn = await pool.getConnection();
        console.log('Successfully connected to the database');
        conn.release();
    } catch (err) {
        console.error('Database connection failed:', err);
        process.exit(1);
    }
}

// Initialize database tables
async function initializeDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                email VARCHAR(100) NOT NULL UNIQUE,
                best_score INT DEFAULT NULL,
                best_speedrun_time INT DEFAULT NULL,
                best_block_times JSON DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        console.log('Database tables initialized');
    } catch (err) {
        console.error('Database initialization failed:', err);
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        dbStatus: pool.pool ? 'connected' : 'disconnected'
    });
});

// User registration
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, email } = req.body;

        // Input validation
        if (!username || !password || !email) {
            return res.status(400).json({ 
                success: false, 
                message: 'Username, password and email are required' 
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters long'
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid email format'
            });
        }

        // Check if user exists
        const [existing] = await pool.query(
            'SELECT id FROM users WHERE username = ? OR email = ?',
            [username, email]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Username or email already exists'
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const [result] = await pool.query(
            'INSERT INTO users (username, password, email) VALUES (?, ?, ?)',
            [username, hashedPassword, email]
        );

        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            userId: result.insertId
        });

    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// User login
// User login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username and password are required'
            });
        }

        // Find user
        const [users] = await pool.query(
            'SELECT * FROM users WHERE username = ?',
            [username]
        );

        if (users.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        const user = users[0];

        // Check password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Форматируем блоки для ответа
        let bestBlockTimes = null;
        if (user.best_block_times) {
            const rawBlockTimes = JSON.parse(user.best_block_times);
            bestBlockTimes = {};
            
            for (const [block, time] of Object.entries(rawBlockTimes)) {
                bestBlockTimes[block] = {
                    time: time,
                    formatted: formatTime(time)
                };
            }
        }

        // Return user data (without password)
        const userData = {
            id: user.id,
            username: user.username,
            email: user.email,
            bestScore: user.best_score,
            bestSpeedrunTime: user.best_speedrun_time,
            bestBlockTimes: bestBlockTimes
        };

        res.status(200).json({
            success: true,
            message: 'Login successful',
            user: userData
        });

    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Save classic game score
// Save classic score (updated version)
app.post('/api/save-classic-score', async (req, res) => {
    try {
        const { userId, score } = req.body;

        // Валидация
        if (!userId || isNaN(score)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid user ID or score' 
            });
        }

        // Обновляем счет, если он больше текущего
        const [result] = await pool.query(
            `UPDATE users 
             SET best_score = GREATEST(IFNULL(best_score, 0), ?)
             WHERE id = ?`,
            [score, userId]
        );

        // Получаем обновленный счет
        const [user] = await pool.query(
            'SELECT best_score FROM users WHERE id = ?',
            [userId]
        );

        res.status(200).json({
            success: true,
            message: 'Score processed',
            newBest: user[0].best_score
        });

    } catch (error) {
        console.error('Database error:', error);
        return res.status(500).json({
            success: false,
            message: 'Database operation failed'
        });
    }
});

// Get leaderboard (classic mode)
app.get('/api/leaderboard/classic', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        // Get total count
        const [countResult] = await pool.query(
            'SELECT COUNT(*) as total FROM users WHERE best_score > 0'
        );
        const total = countResult[0].total;

        // Get leaderboard data
        const [leaderboard] = await pool.query(
            `SELECT id, username, best_score as score 
             FROM users 
             WHERE best_score > 0 
             ORDER BY best_score DESC 
             LIMIT ? OFFSET ?`,
            [limit, offset]
        );

        res.status(200).json({
            success: true,
            data: leaderboard,
            meta: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to get leaderboard'
        });
    }
});

// Get leaderboard (speedrun mode)
app.get('/api/leaderboard/speedrun', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        // Get total count
        const [countResult] = await pool.query(
            'SELECT COUNT(*) as total FROM users WHERE best_speedrun_time IS NOT NULL'
        );
        const total = countResult[0].total;

        // Get leaderboard data
        const [leaderboard] = await pool.query(
            `SELECT id, username, best_speedrun_time as time 
             FROM users 
             WHERE best_speedrun_time IS NOT NULL 
             ORDER BY best_speedrun_time ASC 
             LIMIT ? OFFSET ?`,
            [limit, offset]
        );

        res.status(200).json({
            success: true,
            data: leaderboard,
            meta: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (err) {
        console.error('Speedrun leaderboard error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to get speedrun leaderboard'
        });
    }
});

// Get leaderboard (block times)
app.get('/api/leaderboard/blocks', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;
        const blockValue = parseInt(req.query.block) || 8; // По умолчанию блок 8

        // Получаем всех пользователей с best_block_times
        const [users] = await pool.query(
            'SELECT id, username, best_block_times FROM users WHERE best_block_times IS NOT NULL'
        );

        // Обрабатываем данные
        let blockRecords = [];
        
        users.forEach(user => {
            if (user.best_block_times) {
                const blockTimes = JSON.parse(user.best_block_times);
                if (blockTimes[blockValue]) {
                    blockRecords.push({
                        user_id: user.id,
                        username: user.username,
                        block_value: blockValue,
                        block_time: blockTimes[blockValue]
                    });
                }
            }
        });

        // Сортируем по времени (от меньшего к большему)
        blockRecords.sort((a, b) => a.block_time - b.block_time);

        // Пагинация
        const total = blockRecords.length;
        const paginatedRecords = blockRecords.slice(offset, offset + limit);

        res.status(200).json({
            success: true,
            data: paginatedRecords,
            meta: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
                current_block: blockValue
            }
        });

    } catch (err) {
        console.error('Block times leaderboard error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to get block times leaderboard'
        });
    }
});

// Save block appearance times
app.post('/api/save-block-times', async (req, res) => {
    try {
        const { userId, blockTimes } = req.body;

        if (!userId || !blockTimes) {
            return res.status(400).json({
                success: false,
                message: 'User ID and block times are required'
            });
        }

        // Проверяем, что blockTimes - объект
        if (typeof blockTimes !== 'object' || blockTimes === null) {
            return res.status(400).json({
                success: false,
                message: 'Block times must be an object'
            });
        }

        const [user] = await pool.query(
            'SELECT best_block_times FROM users WHERE id = ?',
            [userId]
        );

        if (user.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const currentBlockTimes = user[0].best_block_times 
            ? JSON.parse(user[0].best_block_times)
            : {};

        const mergedBlockTimes = { ...currentBlockTimes };
        let updated = false;

        // Обновляем время для каждого блока, если оно лучше
        for (const [block, blockTime] of Object.entries(blockTimes)) {
            // Проверяем, что blockTime - число
            if (typeof blockTime !== 'number') continue;
            
            if (!currentBlockTimes[block] || blockTime < currentBlockTimes[block]) {
                mergedBlockTimes[block] = blockTime;
                updated = true;
            }
        }

        if (updated) {
            await pool.query(
                'UPDATE users SET best_block_times = ? WHERE id = ?',
                [JSON.stringify(mergedBlockTimes), userId]
            );
        }

        res.status(200).json({
            success: true,
            message: 'Block times processed',
            updated,
            bestBlockTimes: mergedBlockTimes
        });

    } catch (err) {
        console.error('Save block times error:', err);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Save speedrun time (only for wins)
app.post('/api/save-speedrun-time', async (req, res) => {
    try {
        const { userId, time } = req.body;

        if (!userId || !time) {
            return res.status(400).json({
                success: false,
                message: 'User ID and time are required'
            });
        }

        const [user] = await pool.query(
            'SELECT best_speedrun_time FROM users WHERE id = ?',
            [userId]
        );

        if (user.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const currentBestTime = user[0].best_speedrun_time;
        let updated = false;

        if (currentBestTime === null || time < currentBestTime) {
            await pool.query(
                'UPDATE users SET best_speedrun_time = ? WHERE id = ?',
                [time, userId]
            );
            updated = true;
        }

        res.status(200).json({
            success: true,
            message: 'Speedrun time processed',
            newBest: updated
        });

    } catch (err) {
        console.error('Save speedrun time error:', err);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Get user stats
// Get user stats
app.get('/api/user/:id/stats', async (req, res) => {
    try {
        const userId = req.params.id;

        const [user] = await pool.query(
            `SELECT 
                best_score, 
                best_speedrun_time,
                best_block_times
             FROM users 
             WHERE id = ?`,
            [userId]
        );

        if (user.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Преобразуем JSON в объект и форматируем блоки
        let bestBlockTimes = null;
        if (user[0].best_block_times) {
            const rawBlockTimes = JSON.parse(user[0].best_block_times);
            bestBlockTimes = {};
            
            // Преобразуем ключи в удобный формат и значения в миллисекунды
            for (const [block, time] of Object.entries(rawBlockTimes)) {
                bestBlockTimes[block] = {
                    time: time, // время в миллисекундах
                    formatted: formatTime(time) // отформатированное время
                };
            }
        }

        const stats = {
            bestScore: user[0].best_score,
            bestSpeedrunTime: user[0].best_speedrun_time,
            bestBlockTimes: bestBlockTimes
        };

        res.status(200).json({
            success: true,
            stats
        });

    } catch (err) {
        console.error('Get user stats error:', err);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Функция для форматирования времени (миллисекунды в "мм:сс.мс")
function formatTime(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const milliseconds = ms % 1000;
    
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
}

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found'
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        success: false,
        message: 'Internal server error'
    });
});

// Start server
async function startServer() {
    await testDbConnection();
    await initializeDatabase();
    
    app.listen(port, () => {
        console.log(`Server running on http://localhost:${port}`);
    });
}

startServer();
